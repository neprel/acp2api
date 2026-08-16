import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Metrics, metricsServer } from "../src/metrics.js";

const lines = (m) => m.render().split("\n");
const sample = (m, prefix) => lines(m).filter((l) => l.startsWith(prefix));

test("a turn's tokens are exported per kind, under the agent that spent them", () => {
  const m = new Metrics();
  m.recordUsage({
    agent: "codex",
    usage: { inputTokens: 11, outputTokens: 22, cachedReadTokens: 9, thoughtTokens: 3 },
  });
  const out = sample(m, "acp2api_tokens_total{");
  assert.ok(out.includes('acp2api_tokens_total{agent="codex",kind="input"} 11'));
  assert.ok(out.includes('acp2api_tokens_total{agent="codex",kind="output"} 22'));
  assert.ok(out.includes('acp2api_tokens_total{agent="codex",kind="cached_read"} 9'));
  assert.ok(out.includes('acp2api_tokens_total{agent="codex",kind="reasoning"} 3'));
});

test("counters add up across turns rather than replacing each other", () => {
  const m = new Metrics();
  const usage = { inputTokens: 10, outputTokens: 5 };
  m.recordUsage({ agent: "codex", usage });
  m.recordUsage({ agent: "codex", usage });
  assert.ok(sample(m, "acp2api_tokens_total{").includes('acp2api_tokens_total{agent="codex",kind="input"} 20'));
});

test("an agent that reports no usage is visibly unmeasured, not visibly free", () => {
  const m = new Metrics();
  m.recordOutcome({ agent: "silent", outcome: "ok", seconds: 2 });
  m.recordUsage({ agent: "silent", usage: undefined });
  assert.ok(sample(m, "acp2api_turns_total{").includes('acp2api_turns_total{agent="silent",outcome="ok"} 1'));
  // The gap between turns and usage_reported is the whole signal: no tokens series
  // at all, rather than a zero that reads as "this agent costs nothing".
  assert.equal(sample(m, "acp2api_tokens_total{").length, 0);
  assert.equal(sample(m, "acp2api_usage_reported_total{").length, 0);
});

test("operator labels ride along on every sample, which is how account gets in", () => {
  const m = new Metrics({
    agentLabels: { codex: { account: "neprel-openai", plan: "plus" } },
  });
  m.recordUsage({ agent: "codex", usage: { inputTokens: 5 } });
  m.recordOutcome({ agent: "codex", outcome: "rate_limited", seconds: 1 });
  const all = lines(m).filter((l) => l.startsWith("acp2api_"));
  const labelled = all.filter((l) => l.includes('account="neprel-openai"'));
  assert.equal(labelled.length, all.length, "every sample carries the operator labels");
  assert.ok(labelled.some((l) => l.includes('plan="plus"')));
});

test("one agent's labels never leak onto another's samples", () => {
  const m = new Metrics({ agentLabels: { a: { account: "one" } } });
  m.recordUsage({ agent: "a", usage: { inputTokens: 1 } });
  m.recordUsage({ agent: "b", usage: { inputTokens: 1 } });
  const b = lines(m).find((l) => l.includes('agent="b"'));
  assert.ok(!b.includes("account="));
});

test("a rate-limited turn is counted, because it is the only quota signal ACP has", () => {
  const m = new Metrics();
  m.recordOutcome({ agent: "codex", outcome: "rate_limited", seconds: 0.4 });
  assert.ok(
    sample(m, "acp2api_turns_total{").includes('acp2api_turns_total{agent="codex",outcome="rate_limited"} 1'),
  );
});

test("context fill is a ratio, and the last reading wins", () => {
  const m = new Metrics();
  m.recordUsage({ agent: "codex", context: { used: 50, size: 100 } });
  m.recordUsage({ agent: "codex", context: { used: 25, size: 100 } });
  assert.ok(sample(m, "acp2api_context_fill_ratio{").includes('acp2api_context_fill_ratio{agent="codex"} 0.25'));
});

test("cost is summed in the currency the agent named", () => {
  const m = new Metrics();
  m.recordUsage({ agent: "claude", cost: { amount: 0.25, currency: "USD" } });
  m.recordUsage({ agent: "claude", cost: { amount: 0.25, currency: "USD" } });
  assert.ok(sample(m, "acp2api_cost_total{").includes('acp2api_cost_total{agent="claude",currency="USD"} 0.5'));
});

test("the duration histogram emits buckets, sum and count", () => {
  const m = new Metrics();
  m.recordOutcome({ agent: "codex", outcome: "ok", seconds: 7 });
  const out = lines(m);
  assert.ok(out.some((l) => l.startsWith('acp2api_turn_duration_seconds_bucket{agent="codex",le="15"} 1')));
  assert.ok(out.some((l) => l.startsWith('acp2api_turn_duration_seconds_bucket{agent="codex",le="5"} 0')));
  assert.ok(out.some((l) => l.startsWith('acp2api_turn_duration_seconds_bucket{agent="codex",le="+Inf"} 1')));
  assert.ok(out.some((l) => l === 'acp2api_turn_duration_seconds_sum{agent="codex"} 7'));
  assert.ok(out.some((l) => l === 'acp2api_turn_duration_seconds_count{agent="codex"} 1'));
});

test("a label value with quotes or newlines cannot break the exposition format", () => {
  const m = new Metrics({ agentLabels: { odd: { note: 'a "quoted"\nvalue\\here' } } });
  m.recordUsage({ agent: "odd", usage: { inputTokens: 1 } });
  const line = lines(m).find((l) => l.startsWith("acp2api_tokens_total{"));
  assert.ok(line.includes('note="a \\"quoted\\"\\nvalue\\\\here"'));
  assert.equal(line.split("\n").length, 1);
});

test("every metric declares its HELP and TYPE", () => {
  const m = new Metrics();
  m.recordOutcome({ agent: "codex", outcome: "ok", seconds: 1 });
  m.recordUsage({ agent: "codex", usage: { inputTokens: 1 }, context: { used: 1, size: 2 } });
  const out = lines(m);
  for (const name of [
    "acp2api_turns_total",
    "acp2api_tokens_total",
    "acp2api_usage_reported_total",
    "acp2api_context_fill_ratio",
    "acp2api_turn_duration_seconds",
  ]) {
    assert.ok(out.includes(`# TYPE ${name} ${name.endsWith("_seconds") ? "histogram" : name.endsWith("_ratio") ? "gauge" : "counter"}`), `${name} TYPE`);
    assert.ok(out.some((l) => l.startsWith(`# HELP ${name} `)), `${name} HELP`);
  }
});

test("the listener serves /metrics and nothing else", async (t) => {
  const m = new Metrics();
  m.recordOutcome({ agent: "codex", outcome: "ok", seconds: 1 });
  const server = metricsServer(m, { createServer });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await fetch(`${base}/metrics`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);
  assert.match(await ok.text(), /acp2api_turns_total\{agent="codex",outcome="ok"\} 1/);

  assert.equal((await fetch(`${base}/v1/chat/completions`)).status, 404);
});
