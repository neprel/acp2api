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
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `s${sessions.size + 1}`;
    const state = { model: "fast", effort: "low", verbose: false };
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

    await say({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thinking(${state.effort})` } });
    await say({ sessionUpdate: "tool_call", toolCallId: "t1", title: "noop", status: "completed", kind: "other" });

    if (text.includes("HANG")) {
      const abort = new AbortController();
      state.abort = abort;
      await new Promise((r) => abort.signal.addEventListener("abort", r, { once: true }));
      return { stopReason: "cancelled" };
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
