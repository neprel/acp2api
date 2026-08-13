#!/usr/bin/env node
/**
 * A real ACP agent over real stdio, used by the tests instead of mocking the SDK.
 *
 * Mocking the connection would only prove that our code calls the functions we
 * think it calls; this proves an actual JSON-RPC handshake, a real
 * `session/set_config_option` round trip and real streamed updates. It has no
 * dependency beyond the SDK, so the suite runs offline and burns no subscription.
 *
 * Prompt text drives the behaviour, so a test can ask for the case it wants:
 *   QUOTA       -> fails the way an exhausted subscription does (429 path)
 *   BOOM        -> fails with an unrelated error (must stay 502, not 429)
 *   HANG        -> never finishes on its own (cancellation path)
 *   REFUSE      -> completes with stopReason "refusal"
 *   COUNT       -> streams word by word, so max_tokens and stop have somewhere to cut
 *   ECHOSESSION -> answers with its own session id (continuity, parking, resume)
 *   ECHOMCP     -> answers with the mcpServers it was given
 *   WORK        -> a plan, a diff and a failed tool (the progress renderer)
 *   FILL        -> reports a context window 95% used (retirement)
 *   AMNESIA     -> forgets its own session, so a later resume fails
 *   SHELL       -> drives the client terminal end to end
 *   ESCAPE      -> asks to run outside the workspace, and reports the refusal
 *   KILLIT      -> starts something endless and kills that one command
 *   ECHOMODE    -> answers with the permission mode it was put into
 *   ECHOHEARD   -> answers with everything it has been told, and its fork parent
 *   RUNCMD      -> two shell results, in both shapes an agent may send them
 * anything else is echoed back after one thought chunk.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const MODELS = [
  { value: "fast", name: "Fast" },
  { value: "smart", name: "Smart" },
  // Mirrors Haiku in claude-agent-acp: selecting it REMOVES the thought_level
  // selector, so the option set is not stable across a set_config_option call.
  { value: "lite", name: "Lite (no reasoning selector)" },
];
const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "high", name: "High" },
];

const sessions = new Map();
let opened = 0;

const optionsFor = (state) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model, options: MODELS },
  // Deliberately named `effort`, like claude-agent-acp, so the tests prove that
  // selection happens by category and not by a hardcoded id.
  ...(state.model === "lite"
    ? []
    : [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: state.effort, options: EFFORTS }]),
  // A permission mode, reported under category `mode` the way claude-agent-acp
  // does, so `mode:` in the config is exercised by category and not by id.
  {
    id: "permission-mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: state.mode,
    options: [
      { value: "plan", name: "Plan" },
      { value: "acceptEdits", name: "Accept edits" },
    ],
  },
  { id: "verbose", name: "Verbose", type: "boolean", currentValue: state.verbose },
];

/**
 * Bills one turn against the session's running totals and returns them.
 *
 * Every turn costs the same 11 in / 22 out / 3 thought, so a caller reading the
 * numbers as per-turn sees an identical figure each time and a caller reading them
 * as session totals sees them grow — which is exactly the confusion the bridge has
 * to resolve. The first turn writes the prompt cache and later turns read it, so
 * the cache counters move too.
 */
function chargeTurn(state) {
  state.turns += 1;
  const u = state.usage;
  u.inputTokens += 11;
  u.outputTokens += 22;
  u.thoughtTokens += 3;
  if (state.turns === 1) u.cachedWriteTokens += 11;
  else u.cachedReadTokens += 10;
  u.totalTokens = u.inputTokens + u.outputTokens;
  return { ...u };
}

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      sessionCapabilities: { close: {}, resume: {}, fork: {} },
    },
    // Both shipped adapters advertise steering HERE, at the top level, and not
    // inside `agentCapabilities` -- looking in the wrong object is what once
    // produced the conclusion that codex could not steer at all. `NOSTEER=1` drops
    // it, so a test can prove the bridge refuses to inject into an agent that never
    // claimed the capability rather than trying something that might deadlock.
    ...(process.env.NOSTEER ? {} : { _meta: { steering: { supported: true } } }),
    agentInfo: { name: "fake-agent", version: "1.0.0" },
  }))
  // The measured contract of both adapters: answer immediately and leave the
  // running prompt alone, so that prompt still reports the whole turn.
  //
  // The SDK refuses an unknown method without a params parser, so this passes one
  // through: the shape is the adapters' own (`{sessionId, prompt, _meta}`) and the
  // fixture has no schema to validate it against.
  .onRequest("_session/steering", (p) => p, ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw new Error(`no such session ${params.sessionId}`);
    // `STEER_OUTCOME` lets a test drive the outcomes that are NOT success --
    // `startedNewTurn` (a whole turn began unasked) and `promptRequired` (nothing
    // happened) both have to reach the caller as "did not join".
    const outcome = process.env.STEER_OUTCOME || "injected";
    if (outcome !== "injected") return { outcome };
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
    state.heard = [...(state.heard ?? []), text];
    // Releases the running SLOWTURN, which has been waiting for exactly this. The
    // turn then answers with everything it heard, injection included -- which is
    // the whole behaviour under test.
    state.steered?.();
    return { outcome: "injected" };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    // Monotonic, NOT derived from the live count: ids must never be reused after a
    // session closes, or a test asserting "this is a different session" passes by
    // accident when the id happens to come round again.
    const sessionId = `s${++opened}`;
    const state = {
      model: "fast",
      effort: "low",
      mode: "plan",
      verbose: false,
      mcp: params.mcpServers ?? [],
      // ACP token counters are totals for the SESSION, not for a turn, and a real
      // agent accumulates them across every prompt. The fixture does the same so
      // the bridge's per-turn arithmetic is exercised rather than assumed.
      turns: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        thoughtTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
    };
    sessions.set(sessionId, state);
    return { sessionId, configOptions: optionsFor(state) };
  })
  // `session/close` frees resources; it is not `session/delete`. So the state stays
  // put and only stops being active -- which is what makes a parked session
  // resumable, and what this fixture has to model for the bridge to be tested
  // honestly.
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (state) state.closed = true;
    return {};
  })
  // A fork is a NEW session carrying a copy of the parent's history, which is what
  // makes a warm base worth having: whatever the parent read, the child starts with.
  .onRequest(acp.methods.agent.session.fork, ({ params }) => {
    const parent = sessions.get(params.sessionId);
    if (!parent) throw new Error(`unknown session ${params.sessionId}`);
    const sessionId = `s${++opened}`;
    sessions.set(sessionId, {
      ...parent,
      forkedFrom: params.sessionId,
      heard: [...(parent.heard ?? [])],
      turns: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    });
    return { sessionId, configOptions: optionsFor(sessions.get(sessionId)) };
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    const state = sessions.get(params.sessionId);
    // An id this agent never issued, or one that was deleted, cannot come back.
    if (!state) throw new Error(`unknown session ${params.sessionId}`);
    state.closed = false;
    state.resumed = (state.resumed ?? 0) + 1;
    return { sessionId: params.sessionId, configOptions: optionsFor(state) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw new Error(`no such session ${params.sessionId}`);
    if (params.configId === "verbose") state.verbose = params.value;
    else if (params.configId === "permission-mode") state.mode = params.value;
    else state[params.configId === "effort" ? "effort" : "model"] = params.value;
    return { configOptions: optionsFor(state) };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw new Error(`no such session ${params.sessionId}`);
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
    state.heard = [...(state.heard ?? []), text];

    if (text.includes("QUOTA")) throw new Error("Claude usage limit reached. Your limit will reset at 3pm.");
    if (text.includes("BOOM")) throw new Error("connection reset by peer");

    const say = (update) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
    state.abort = new AbortController();

    // A turn slow enough to be steered into, which answers with EVERYTHING this
    // session has been told -- so a test can see whether the injected text was
    // folded into this turn's own answer.
    //
    // It waits for the STEER, not for a duration. A fixed 400 ms was a bet that
    // the injecting request would arrive inside it, and that bet is lost on a
    // machine slow enough: the turn ends first, the injection finds nothing to
    // join, and the test fails claiming the bridge did not deliver.
    //
    // The cap is only for the tests where nothing is ever injected -- an agent
    // that refuses to steer, a request that forks instead. It is generous against
    // the ~50 ms an injection needs once the turn is known to be running, and
    // small enough that four such tests do not dominate the suite.
    if (text.includes("SLOWTURN")) {
      await Promise.race([
        new Promise((resolve) => { state.steered = resolve; }),
        new Promise((r) => setTimeout(r, 1_500)),
      ]);
      state.steered = null;
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `HEARD:${state.heard.join("|")}` } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    await say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thinking(${state.effort})` } });
    await say({ sessionUpdate: "tool_call", toolCallId: "t1", title: "noop", status: "completed", kind: "other" });

    // A turn with visible activity: a plan that advances, an edit that carries a
    // real diff, and a tool that fails. Enough for the progress renderer to be
    // exercised against the shapes an agent actually sends.
    if (text.includes("WORK")) {
      await say({
        sessionUpdate: "plan",
        entries: [
          { content: "read the config", status: "completed", priority: "high" },
          { content: "patch the compose file", status: "in_progress", priority: "high" },
          { content: "restart", status: "pending", priority: "medium" },
        ],
      });
      await say({
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "Edit compose.yaml",
        kind: "edit",
        status: "in_progress",
      });
      await say({
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        status: "completed",
        content: [{ type: "diff", path: "compose.yaml", oldText: "a\nb\nc\n", newText: "a\nB1\nB2\nc\n" }],
      });
      await say({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Bash pytest", kind: "execute", status: "failed" });
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // A turn that NARRATES itself: a sentence, then work, then another sentence,
    // then work, then the actual answer. This is what a coding agent really sends,
    // and it is the shape `server.commentary` exists to sort out -- every run of
    // text but the last is commentary, and only a FOLLOWING tool call says so.
    if (text.includes("NARRATE")) {
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking both hosts." } });
      await say({ sessionUpdate: "tool_call", toolCallId: "n1", title: "ssh build-host", kind: "execute", status: "completed" });
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Not in the docker group; using sudo." } });
      await say({ sessionUpdate: "tool_call", toolCallId: "n2", title: "sudo docker ps", kind: "execute", status: "completed" });
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing is restarting." } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Answers with everything this session has ever been told, so a test can prove a
    // fork inherited the warm base's history rather than starting blank.
    if (text.includes("ECHOHEARD")) {
      await say({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify({ id: params.sessionId, from: state.forkedFrom ?? null, heard: state.heard }) },
      });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Answers with the permission mode it was put into, so a test can prove `mode:`
    // resolves by CATEGORY and not by the option id.
    if (text.includes("ECHOMODE")) {
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: state.mode } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Reports a context window nearly used up, so a test can drive retirement
    // without having to actually fill one.
    if (text.includes("FILL")) {
      await say({ sessionUpdate: "usage_update", used: 95, size: 100 });
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.sessionId } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Forgets its own session on the way out, so a later `session/resume` fails the
    // way a real agent's would once its stored transcript is gone.
    if (text.includes("AMNESIA")) {
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.sessionId } });
      sessions.delete(params.sessionId);
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Drives the client terminal the way a real agent does: create, wait, read,
    // release. Answers with what it saw, so a test can assert the whole round trip
    // rather than that a handler exists.
    if (text.includes("SHELL")) {
      try {
        const { terminalId } = await client.request(acp.methods.client.terminal.create, {
          sessionId: params.sessionId,
          command: process.execPath,
          args: ["-e", "process.stdout.write('out-'); process.stderr.write('err')"],
        });
        const exit = await client.request(acp.methods.client.terminal.waitForExit, {
          sessionId: params.sessionId,
          terminalId,
        });
        const seen = await client.request(acp.methods.client.terminal.output, {
          sessionId: params.sessionId,
          terminalId,
        });
        await client.request(acp.methods.client.terminal.release, { sessionId: params.sessionId, terminalId });
        await say({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ exit, ...seen }) },
        });
      } catch (e) {
        await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `REFUSED: ${e.data ?? e.message}` } });
      }
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Asks to run somewhere outside the workspace, which the client must refuse.
    if (text.includes("ESCAPE")) {
      try {
        await client.request(acp.methods.client.terminal.create, {
          sessionId: params.sessionId,
          command: process.execPath,
          args: ["-e", "0"],
          cwd: "/",
        });
        await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ALLOWED" } });
      } catch (e) {
        await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `REFUSED: ${e.data ?? e.message}` } });
      }
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Starts something that never ends, then stops that ONE command -- the thing
    // session/cancel cannot do without ending the turn as well.
    if (text.includes("KILLIT")) {
      const { terminalId } = await client.request(acp.methods.client.terminal.create, {
        sessionId: params.sessionId,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
      await client.request(acp.methods.client.terminal.kill, { sessionId: params.sessionId, terminalId });
      const exit = await client.request(acp.methods.client.terminal.waitForExit, {
        sessionId: params.sessionId,
        terminalId,
      });
      await say({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(exit) },
      });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Two shell commands, sent EXACTLY the way claude-agent-acp puts them on the
    // wire -- captured from a live agent on 2026-08-12. Six updates per command,
    // with the command, the output and the exit code in three different ones. The
    // second command uses the fenced-console fallback an agent sends when the
    // client did not advertise terminal_output.
    if (text.includes("RUNCMD")) {
      const bash = async (id, command, output, exitCode) => {
        await say({ sessionUpdate: "tool_call", toolCallId: id, title: "Terminal", kind: "execute",
          status: "pending", rawInput: {}, content: [{ terminalId: id, type: "terminal" }],
          _meta: { terminal_info: { terminal_id: id } } });
        await say({ sessionUpdate: "tool_call_update", toolCallId: id, title: command, kind: "execute",
          rawInput: { command } });
        await say({ sessionUpdate: "tool_call_update", toolCallId: id,
          _meta: { terminal_output: { terminal_id: id, data: output } } });
        await say({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed",
          content: [{ terminalId: id, type: "terminal" }],
          _meta: { terminal_exit: { terminal_id: id, exit_code: exitCode, signal: null } } });
      };
      await bash("b1", "make check", "buried-by-the-cap\nchecking\nall good", 2);
      await say({ sessionUpdate: "tool_call", toolCallId: "b2", title: "Terminal", kind: "execute",
        status: "pending", rawInput: {} });
      await say({ sessionUpdate: "tool_call_update", toolCallId: "b2", title: "npm test",
        kind: "execute", rawInput: { command: "npm test" } });
      await say({ sessionUpdate: "tool_call_update", toolCallId: "b2", status: "failed",
        content: [{ type: "content", content: { type: "text", text: "```console\nnoise\n1 failed, 3 passed\n```" } }] });
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran" } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    if (text.includes("HANG")) {
      await new Promise((r) => state.abort.signal.addEventListener("abort", r, { once: true }));
      return { stopReason: "cancelled" };
    }

    // Behaves like a real ACP agent that was handed an MCP server: connects to it,
    // lists what it offers, calls one, and folds the result into its answer.
    //
    // Written over HTTP rather than stubbed, because the thing under test is the
    // bridge's MCP endpoint -- a stub would prove only that the test agrees with
    // itself. `USETOOL <name> <json>` picks the tool and its arguments.
    if (text.includes("USETOOL")) {
      const server = (state.mcp ?? []).find((s) => s.name === "acp2api-client-tools");
      if (!server) {
        await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NO-TOOL-SERVER" } });
        return { stopReason: "end_turn" };
      }
      const rpc = async (method, params, id) => {
        const res = await fetch(server.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        return res.status === 202 ? null : await res.json();
      };
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake" } }, 1);
      const listed = await rpc("tools/list", {}, 2);
      const [, name, args] = /USETOOL\s+(\S+)\s*(\{.*\})?/.exec(text) ?? [];
      await say({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `TOOLS:${listed.result.tools.map((t) => t.name).join(",")} ` },
      });
      const called = await rpc("tools/call", { name, arguments: args ? JSON.parse(args) : {} }, 3);
      const got = called.result?.content?.[0]?.text ?? `ERROR:${called.error?.message}`;
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `RESULT:${got}` } });
      return { stopReason: "end_turn", usage: chargeTurn(state) };
    }

    // Reports what session/new was given, so a test can prove MCP servers and
    // attachment blocks actually reached the agent instead of being dropped.
    if (text.includes("ECHOMCP")) {
      await say({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(state.mcp) },
      });
      return { stopReason: "end_turn" };
    }

    // Answers with its own session id, so a test can prove a conversation was
    // continued in the SAME ACP session rather than silently restarted.
    if (text.includes("ECHOSESSION")) {
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.sessionId } });
      return { stopReason: "end_turn" };
    }

    // Streams one word at a time so `stop` and `max_tokens` have somewhere to cut.
    if (text.includes("COUNT")) {
      for (let i = 1; i <= 20; i++) {
        await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `word${i} ` } });
        if (state.abort?.signal.aborted) return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn" };
    }

    for (const part of [`[${state.model}] `, text]) {
      await say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
    }
    return {
      stopReason: text.includes("REFUSE") ? "refusal" : "end_turn",
      usage: chargeTurn(state),
    };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
