#!/usr/bin/env node
/**
 * A real ACP agent over real stdio, used by the tests instead of mocking the SDK.
 *
 * Mocking the connection would only prove that our code calls the functions we
 * think it calls; this proves an actual JSON-RPC handshake, a real
 * `session/set_config_option` round trip and real streamed updates. It has no
 * dependency beyond the SDK, so the suite runs offline and burns no subscription.
 *
 * Prompt text drives the behaviour, so a test can ask for the failure it wants:
 *   QUOTA   -> fails the way an exhausted subscription does (429 path)
 *   BOOM    -> fails with an unrelated error (must stay 502, not 429)
 *   HANG    -> never finishes on its own (cancellation path)
 *   REFUSE  -> completes with stopReason "refusal"
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
    agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    agentInfo: { name: "fake-agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    // Monotonic, NOT derived from the live count: ids must never be reused after a
    // session closes, or a test asserting "this is a different session" passes by
    // accident when the id happens to come round again.
    const sessionId = `s${++opened}`;
    const state = {
      model: "fast",
      effort: "low",
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
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw new Error(`no such session ${params.sessionId}`);
    if (params.configId === "verbose") state.verbose = params.value;
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

    if (text.includes("QUOTA")) throw new Error("Claude usage limit reached. Your limit will reset at 3pm.");
    if (text.includes("BOOM")) throw new Error("connection reset by peer");

    const say = (update) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
    state.abort = new AbortController();

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

    if (text.includes("HANG")) {
      await new Promise((r) => state.abort.signal.addEventListener("abort", r, { once: true }));
      return { stopReason: "cancelled" };
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
