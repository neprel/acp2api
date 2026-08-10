import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, ParamReporter } from "../src/params.js";
import { estimateTokens, makeLimiter, parseChatRequest } from "../src/openai.js";

const base = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("style-only parameters are ignored, not refused", () => {
  // Every OpenAI client library sends temperature unasked. Refusing it would fail
  // nearly every real request over a difference the caller cannot perceive.
  const { ignored, refused } = classify({ ...base, temperature: 0, top_p: 1, seed: 7 });
  assert.deepEqual(ignored, ["seed", "temperature", "top_p"]);
  assert.deepEqual(refused, []);
});

test("contract-changing parameters are refused regardless of the setting", () => {
  // Ignoring `tools` returns prose to a caller waiting for tool_calls, which breaks
  // inside its own agent loop with no clue why. A 400 is kinder than that 200.
  const { refused } = classify({ ...base, tools: [{ type: "function" }] });
  assert.equal(refused.length, 1);
  assert.equal(refused[0].key, "tools");
  assert.match(refused[0].why, /mcpServers/);
  for (const key of ["tool_choice", "response_format", "functions", "audio"]) {
    assert.equal(classify({ ...base, [key]: {} }).refused[0]?.key, key);
  }
});

test("n is refused above 1 and free below", () => {
  assert.deepEqual(classify({ ...base, n: 1 }).refused, []);
  assert.deepEqual(classify({ ...base, n: null }).refused, []);
  assert.equal(classify({ ...base, n: 3 }).refused[0].key, "n");
});

test("unknown future parameters are ignored rather than refused", () => {
  // OpenAI adds fields faster than a bridge tracks them; failing on a name we have
  // simply not heard of would age badly.
  assert.deepEqual(classify({ ...base, some_2027_field: true }).ignored, ["some_2027_field"]);
});

test("natively handled and emulated parameters are neither ignored nor refused", () => {
  const c = classify({ ...base, stream: true, max_tokens: 10, stop: ["x"], stream_options: {} });
  assert.deepEqual(c.ignored, []);
  assert.deepEqual(c.refused, []);
});

test("the reporter logs each (model, parameter) pair exactly once", () => {
  const lines = [];
  const r = new ParamReporter("warn", (_l, m) => lines.push(m));
  r.report("a", ["temperature"]);
  r.report("a", ["temperature"]);
  r.report("a", ["temperature", "seed"]);
  r.report("b", ["temperature"]);
  // Not once per request: a client looping with temperature would drown the log.
  assert.equal(lines.length, 3);
  assert.match(lines[0], /a: ignoring "temperature"/);
  assert.match(lines[2], /b: ignoring "temperature"/);
});

test("mode ignore is silent, mode error rejects", () => {
  const lines = [];
  assert.deepEqual(new ParamReporter("ignore", (_l, m) => lines.push(m)).report("a", ["temperature"]), ["temperature"]);
  assert.equal(lines.length, 0);
  assert.throws(() => new ParamReporter("error", () => {}).report("a", ["temperature"]), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, "unsupported_parameter");
    return true;
  });
});

test("parseChatRequest refuses contract-changing parameters with a reason", () => {
  assert.throws(() => parseChatRequest({ ...base, tools: [] }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /`tools` is not supported/);
    return true;
  });
});

test("parseChatRequest surfaces the emulated knobs and validates them", () => {
  const r = parseChatRequest({ ...base, max_tokens: 5, stop: "END", stream_options: { include_usage: true } });
  assert.equal(r.maxTokens, 5);
  assert.deepEqual(r.stop, ["END"]);
  assert.equal(r.includeUsage, true);
  // max_completion_tokens is the current spelling and wins over the legacy one.
  assert.equal(parseChatRequest({ ...base, max_tokens: 5, max_completion_tokens: 9 }).maxTokens, 9);
  assert.throws(() => parseChatRequest({ ...base, max_tokens: 0 }), /positive integer/);
  assert.throws(() => parseChatRequest({ ...base, stop: [""] }), /non-empty string/);
});

test("no limiter is built when nothing needs limiting", () => {
  assert.equal(makeLimiter({ maxTokens: null, stop: [] }), null);
});

test("a stop sequence cuts the text and excludes itself", () => {
  const limit = makeLimiter({ maxTokens: null, stop: ["STOP"] });
  assert.equal(limit("all good so far"), null);
  assert.deepEqual(limit("keep this STOP drop this"), { stopReason: "end_turn", text: "keep this " });
});

test("max_tokens truncates and reports length", () => {
  const limit = makeLimiter({ maxTokens: 2, stop: [] });
  assert.equal(limit("12345678"), null); // exactly 2 tokens by the estimate
  const cut = limit("123456789");
  assert.equal(cut.stopReason, "max_tokens");
  assert.equal(cut.text.length, 8);
});

test("the token estimate is documented as approximate, and monotonic", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.ok(estimateTokens("a".repeat(100)) > estimateTokens("a".repeat(50)));
});
