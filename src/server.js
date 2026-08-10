import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Agent, AgentError } from "./agent.js";
import { ParamReporter } from "./params.js";
import {
  chunk,
  completion,
  errorBody,
  makeLimiter,
  newCompletionId,
  parseChatRequest,
  RequestError,
  usageChunk,
} from "./openai.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Constant-time compare that does not leak length through an early return. */
function secretEquals(a, b) {
  const x = Buffer.from(a ?? "", "utf8");
  const y = Buffer.from(b ?? "", "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError("request body too large", 413, "payload_too_large"));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Builds the HTTP server.
 *
 * `agents` is injectable so tests can drive the HTTP layer without spawning
 * anything; in production it is built from the config.
 */
export function createServer(config, { agents, log = () => {} } = {}) {
  const registry =
    agents ??
    new Map(config.agents.map((spec) => [spec.name, new Agent(spec, config.server, log)]));
  const params = new ParamReporter(config.server.unsupportedParams, log);

  const authorized = (req) => {
    if (!config.server.apiKey) return true;
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    // x-api-key too: Anthropic-style clients send that instead, and both are
    // pointing at the same server here.
    return secretEquals(bearer, config.server.apiKey) || secretEquals(req.headers["x-api-key"], config.server.apiKey);
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/health") return send(res, 200, { status: "ok", agents: [...registry.keys()] });
      if (!authorized(req)) return send(res, 401, errorBody("invalid api key", "invalid_api_key", "authentication_error"));

      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return send(res, 200, {
          object: "list",
          data: [...registry.values()].map((a) => ({
            id: a.name,
            object: "model",
            created: 0,
            owned_by: a.spec.type,
          })),
        });
      }

      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        return await handleCompletion(req, res, registry, config, log, params);
      }

      return send(res, 404, errorBody(`no route for ${req.method} ${url.pathname}`, "not_found"));
    } catch (e) {
      const status = e.status ?? 500;
      log(status >= 500 ? "error" : "warn", `${req.method} ${url.pathname} -> ${status}: ${e.message}`);
      if (!res.headersSent) send(res, status, errorBody(e.message, e.code ?? "internal_error"));
      else res.end();
    }
  });

  server.on("close", () => {
    for (const agent of registry.values()) agent.close?.();
  });
  return server;
}

async function handleCompletion(req, res, registry, config, log, params) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    throw e instanceof RequestError ? e : new RequestError(`invalid JSON body: ${e.message}`);
  }

  const { model, blocks, stream, includeUsage, maxTokens, stop, ignored } = parseChatRequest(body);
  params.report(model, ignored);
  const limit = makeLimiter({ maxTokens, stop });
  const agent = registry.get(model);
  if (!agent) {
    throw new RequestError(
      `model "${model}" not found; available: ${[...registry.keys()].join(", ")}`,
      404,
      "model_not_found",
    );
  }

  // One controller for both ends: the client hanging up cancels the ACP turn, and
  // so does the timeout, rather than leaving an agent working for nobody. The two
  // are tracked apart because they need opposite answers -- a timeout owes the
  // caller a 504, a vanished client owes it nothing.
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.server.requestTimeoutMs);
  req.once("close", () => {
    if (res.writableEnded) return;
    clientGone = true;
    controller.abort();
  });

  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const meta = { id, model, created };
  const timeout = () =>
    new AgentError(`${model}: no answer within ${config.server.requestTimeoutMs}ms`, 504, "timeout");

  try {
    if (!stream) {
      const turn = await agent.prompt(blocks, { signal: controller.signal, limit });
      if (clientGone) return res.end();
      // ACP reports cancellation as an ordinary stop reason, so without this a
      // timed-out turn would return 200 with whatever partial text it had -- which
      // a router downstream would count as success.
      if (timedOut) throw timeout();
      return send(res, 200, completion({ ...meta, ...turn, ignored }));
    }

    // Headers go out only once the turn is under way. Sending them earlier would
    // commit to 200 before knowing whether the agent can even start, turning a
    // clean 429 -- the one an upstream router needs to fail over -- into a stream
    // that just stops.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      write(res, chunk({ ...meta, delta: { role: "assistant", content: "" } }));
    };

    const turn = await agent.prompt(blocks, {
      signal: controller.signal,
      limit,
      onEvent: (e) => {
        // The agent's own tool calls are progress, not content: emitting them as
        // text would put "running bash" inside the answer.
        if (e.type === "tool_call") return;
        start();
        const delta = e.type === "reasoning" ? { reasoning_content: e.delta } : { content: e.delta };
        write(res, chunk({ ...meta, delta }));
      },
    });

    if (clientGone) return res.end();
    // Nothing was streamed yet, so the status is still ours to choose.
    if (timedOut && !started) throw timeout();

    start(); // an empty turn still owes the client a well-formed stream
    // Mid-stream there is no status left to change, so say "length": the answer is
    // genuinely truncated, and that is the closest honest finish_reason.
    write(res, chunk({ ...meta, delta: {}, finishReason: timedOut ? "length" : finishOf(turn.stopReason) }));
    if (includeUsage && turn.usage) write(res, usageChunk({ ...meta, usage: turn.usage }));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    if (clientGone) {
      log("warn", `${model}: client disconnected`);
      return res.end();
    }
    if (timedOut && !(e instanceof AgentError && e.status === 429)) {
      log("warn", `${model}: timed out after ${config.server.requestTimeoutMs}ms`);
      if (!res.headersSent) return send(res, 504, errorBody(timeout().message, "timeout"));
      return res.end();
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const finishOf = (stopReason) =>
  ({ max_tokens: "length", max_turn_requests: "length", refusal: "content_filter" })[stopReason] ?? "stop";

function write(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
