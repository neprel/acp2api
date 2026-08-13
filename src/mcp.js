/**
 * The caller's own tools, offered to the agent as an MCP server.
 *
 * Why this is the only way in
 * --------------------------
 * `session/prompt` carries `{sessionId, prompt, _meta}`. There is no `tools` field
 * and there is not going to be one: an ACP agent runs its OWN tool loop, and the
 * protocol's answer to "how does it get tools" is `mcpServers`, declared when the
 * session opens. So a caller that sends OpenAI `tools` cannot be served by passing
 * anything down. It can only be served by becoming a tool server.
 *
 * That is what this is: a small MCP server, in-process, on the bridge's own HTTP
 * port, whose tool list is whatever the current request declared. The agent
 * connects to it like any other MCP server and never learns that the tools belong
 * to whoever is on the other end of the completion.
 *
 * The hard part is not the protocol
 * ---------------------------------
 * It is that an MCP tool call has to be ANSWERED, and only the caller can answer
 * it -- over HTTP, in a later request, in OpenAI's shape. So a call is PARKED: the
 * JSON-RPC response is held open, the HTTP layer ends its completion with
 * `finish_reason: "tool_calls"`, and the next request carrying `role: "tool"`
 * results resolves it. The ACP turn never ends; it is sitting inside a tool call,
 * which is a perfectly ordinary thing for a turn to be doing.
 *
 * A parked call is therefore a promise with a deadline. If the caller never comes
 * back -- it crashed, it gave up, it decided not to run the tool -- the call is
 * failed rather than left, because the alternative is an agent process waiting
 * forever on a subscription that is still being paid for.
 *
 * Transport
 * ---------
 * Streamable HTTP, stateless: the session is named by the token in the URL, so no
 * `Mcp-Session-Id` is issued and none is expected. Requests are answered as plain
 * JSON. There is no server-initiated stream, so `GET` is refused -- which the spec
 * allows in as many words for a server that does not offer one.
 */

import { randomUUID } from "node:crypto";

/** The version spoken when a client asks for nothing in particular. */
const PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC error codes used here, with the meanings MCP gives them. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

/**
 * One conversation's tools, and the calls the agent has made against them.
 *
 * Held per CONVERSATION rather than per request, because that is the thing that
 * outlives a completion: the parked call raised by request N is answered by
 * request N+1, and both are the same conversation.
 */
class Bench {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    /** OpenAI tool definitions, as last declared by the caller. */
    this.tools = [];
    /** callId -> {name, args, settle, timer, reported} */
    this.pending = new Map();
    /** Woken when a call parks, so the HTTP layer can stop waiting for the turn. */
    this.wake = null;
  }
}

export class ToolBridge {
  #benches = new Map(); // token -> Bench
  #log;
  #timeoutMs;

  constructor({ timeoutMs = 600_000, log = () => {} } = {}) {
    this.#timeoutMs = timeoutMs;
    this.#log = log;
  }

  /** Opens a bench and returns the token its MCP URL is named by. */
  open(tools = []) {
    const token = randomUUID();
    const bench = new Bench(this.#timeoutMs);
    bench.tools = tools;
    this.#benches.set(token, bench);
    return token;
  }

  /**
   * Replaces the tool list a bench serves.
   *
   * The agent listed the tools when it connected and is not told they changed --
   * there is no stream here to tell it on. In practice a client sends the same
   * array for the life of a conversation; one that does not gets the newest list
   * the next time it lists, and nothing worse.
   */
  setTools(token, tools) {
    const bench = this.#benches.get(token);
    if (bench && Array.isArray(tools)) bench.tools = tools;
  }

  /** Every call parked on this bench and not yet handed to the caller. */
  parked(token) {
    const bench = this.#benches.get(token);
    if (!bench) return [];
    return [...bench.pending.entries()]
      .filter(([, call]) => !call.reported)
      .map(([id, call]) => ({ id, name: call.name, arguments: call.args }));
  }

  /** Marks parked calls as handed over, so they are reported exactly once. */
  reported(token, ids) {
    const bench = this.#benches.get(token);
    if (!bench) return;
    for (const id of ids) {
      const call = bench.pending.get(id);
      if (call) call.reported = true;
    }
  }

  /** Resolves a parked call with the caller's result. Unknown ids are ignored. */
  resolve(token, callId, text) {
    const bench = this.#benches.get(token);
    const call = bench?.pending.get(callId);
    if (!call) return false;
    bench.pending.delete(callId);
    clearTimeout(call.timer);
    call.settle({ content: [{ type: "text", text: String(text ?? "") }] });
    return true;
  }

  /** A promise that settles when the next call parks on this bench. */
  nextPark(token) {
    const bench = this.#benches.get(token);
    if (!bench) return new Promise(() => {});
    if (this.parked(token).length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      bench.wake = resolve;
    });
  }

  /**
   * Closes a bench and fails everything still parked on it.
   *
   * Called when the conversation ends. Leaving a parked call behind would leave
   * the agent blocked inside a tool call on a session nobody can reach.
   */
  close(token) {
    const bench = this.#benches.get(token);
    if (!bench) return;
    this.#benches.delete(token);
    for (const [, call] of bench.pending) {
      clearTimeout(call.timer);
      call.settle({
        content: [{ type: "text", text: "the client ended the conversation before answering this tool call" }],
        isError: true,
      });
    }
    bench.pending.clear();
  }

  /**
   * Handles one JSON-RPC message from the agent's MCP client.
   *
   * Returns the response object, or null for a notification -- which takes no
   * reply, and whose HTTP status is the caller's business.
   */
  async handle(token, message) {
    const bench = this.#benches.get(token);
    const { id = null, method, params } = message ?? {};
    // A notification has no id and gets no answer. `notifications/initialized` is
    // the one every client sends; the rest are ignored on purpose rather than
    // answered with an error a notification could not receive anyway.
    if (id === null || id === undefined) return null;
    if (!bench) return rpcError(id, INVALID_PARAMS, "unknown tool session");

    if (method === "initialize") {
      return rpcResult(id, {
        // Echo what the client asked for when it is a version at all. A stricter
        // answer buys nothing: this server's surface is `tools/list` and
        // `tools/call`, which have not changed across the versions in the wild.
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "acp2api", version: "1" },
      });
    }

    if (method === "tools/list") {
      return rpcResult(id, { tools: bench.tools.map(toMcpTool).filter(Boolean) });
    }

    if (method === "tools/call") {
      const name = params?.name;
      if (typeof name !== "string" || !bench.tools.some((t) => toMcpTool(t)?.name === name)) {
        return rpcError(id, INVALID_PARAMS, `no such tool: ${name}`);
      }
      return rpcResult(id, await this.#park(token, bench, name, params?.arguments ?? {}));
    }

    return rpcError(id, METHOD_NOT_FOUND, `unsupported method: ${method}`);
  }

  /** Holds a call open until the caller answers it, or the deadline passes. */
  #park(token, bench, name, args) {
    const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        bench.pending.delete(callId);
        this.#log("warn", `tool call ${name} was never answered in ${bench.timeoutMs}ms`);
        settle({
          content: [{ type: "text", text: `the client did not answer this tool call within ${bench.timeoutMs}ms` }],
          isError: true,
        });
      }, bench.timeoutMs);
      // Unref'd: a parked call must not be the reason the process stays alive.
      timer.unref?.();
      bench.pending.set(callId, { name, args: argsToJson(args), settle, timer, reported: false });
      const wake = bench.wake;
      bench.wake = null;
      wake?.();
    });
  }
}

/** OpenAI's arguments are a JSON STRING; MCP's are an object. */
const argsToJson = (args) => {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
};

/**
 * One OpenAI tool definition in MCP's shape, or null when it is not a function
 * tool this can serve (`type: "custom"`, a hosted tool, anything unrecognised).
 */
export function toMcpTool(tool) {
  const fn = tool?.function ?? (tool?.name ? tool : null);
  if (!fn || typeof fn.name !== "string" || fn.name === "") return null;
  return {
    name: fn.name,
    description: fn.description ?? "",
    // MCP calls it `inputSchema`; OpenAI calls it `parameters`. An absent schema
    // is a tool that takes nothing, which is a real thing to declare.
    inputSchema: fn.parameters ?? { type: "object", properties: {} },
  };
}
