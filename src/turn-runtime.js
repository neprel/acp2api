import { deltaUsage } from "./openai.js";
import { fingerprint } from "./sessions.js";

const regexLiteral = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function suspectedTextToolCall(tools, bench, text, model, log) {
  const tool = tools.toolNames(bench).find((name) =>
    new RegExp(`(?:^|[^A-Za-z0-9_])${regexLiteral(name)}\\s*\\(`).test(text),
  );
  if (!tool) return null;
  log("warn", `${model}: answer text looks like a call to caller tool "${tool}", but the agent made no tool call`);
  return { agent: model, tool };
}

export function benchServer(httpServer, token) {
  const at = httpServer?.address?.();
  const port = at?.port;
  const host = !at || at.address === "0.0.0.0" || at.address === "::" ? "127.0.0.1" : at.address;
  const authority = host.includes(":") ? `[${host}]` : host;
  return { type: "http", name: "acp2api-client-tools", url: `http://${authority}:${port}/mcp/${token}`, headers: [] };
}

export function makeSink() {
  let listener = null;
  const waiting = [];
  return {
    emit(event) {
      if (listener) listener(event);
      else waiting.push(event);
    },
    attach(fn) {
      listener = fn;
      for (const event of waiting.splice(0)) fn(event);
    },
    detach() {
      listener = null;
    },
  };
}

export async function untilTurnOrToolCall(pending, tools, requestSignal) {
  let ended = null;
  const finished = pending.turn.then(
    (turn) => (ended = { turn }),
    (error) => (ended = { error }),
  );
  const parked = tools.nextPark(pending.bench).then(() => ({ calls: tools.parked(pending.bench) }));
  let onRequestEnd = null;
  const requestEnded = requestSignal
    ? new Promise((resolve) => {
        onRequestEnd = () => resolve({ requestEnded: true });
        if (requestSignal.aborted) onRequestEnd();
        else requestSignal.addEventListener("abort", onRequestEnd, { once: true });
      })
    : new Promise(() => {});
  const outcome = await Promise.race([finished, parked, requestEnded]);
  if (onRequestEnd) requestSignal.removeEventListener("abort", onRequestEnd);
  return ended ?? outcome;
}

export function remember(sessions, convId, prefix, text) {
  if (!convId) return;
  sessions.extendPrefix(convId, [...prefix, fingerprint({ role: "assistant", content: text })]);
}

export async function retireDeadConversation(sessions, convId, session, registry) {
  if (!convId || !session?.dead) return false;
  await sessions.retire(convId, "dead_session", registry);
  return true;
}

export function watchDeadTurn(pending, sessions, convId, registry) {
  pending.turn.then(
    () => pending.session?.dead && !pending.attached && sessions.retire(convId, "dead_session", registry),
    () => pending.session?.dead && !pending.attached && sessions.retire(convId, "dead_session", registry),
  ).catch(() => {});
}

export function settleUsage(sessions, convId, turn) {
  if (!convId || !turn) return turn;
  if (turn.context) sessions.rememberContext(convId, turn.context);
  let cost = turn.cost;
  if (Number.isFinite(cost?.amount)) {
    const before = sessions.costBaseline(convId)?.amount ?? 0;
    sessions.rememberCost(convId, cost);
    cost = { ...cost, amount: cost.amount >= before ? cost.amount - before : cost.amount };
  }
  let usage;
  if (turn.usage) {
    usage = deltaUsage(turn.usage, sessions.usageBaseline(convId));
    sessions.rememberUsage(convId, turn.usage);
  }
  sessions.metrics?.recordUsage({
    agent: sessions.agentOf(convId),
    usage,
    cost,
    context: turn.context,
  });
  if (!usage) return { ...turn, cost };
  return { ...turn, usage, cost };
}

export const finishOf = (stopReason) =>
  ({ max_tokens: "length", max_turn_requests: "length", refusal: "content_filter" })[stopReason] ?? "stop";

export const timeoutError = (model, config, AgentErrorClass) =>
  new AgentErrorClass(`${model}: no answer within ${config.server.requestTimeoutMs}ms`, 504, "timeout");
