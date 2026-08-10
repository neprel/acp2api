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
    const state = { model: "fast", effort: "low", verbose: false, mcp: params.mcpServers ?? [] };
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
      usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, thoughtTokens: 3 },
    };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
