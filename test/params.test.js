import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, ignoredNestedKeys, normalizeToolPolicy, ParamReporter } from "../src/params.js";
import { estimateTokens, makeLimiter, parseChatRequest } from "../src/openai.js";

const base = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("style-only parameters are ignored, not refused", () => {
  // Every OpenAI client library sends temperature unasked. Refusing it would fail
  // nearly every real request over a difference the caller cannot perceive.
  const { ignored, refused } = classify({ ...base, temperature: 0, top_p: 1, seed: 7 });
  assert.deepEqual(ignored, ["seed", "temperature", "top_p"]);
  assert.deepEqual(refused, []);
});

test("tool definitions and supported choices are classified as emulated", () => {
  const { ignored, refused } = classify({ ...base, tools: [], tool_choice: "auto" });
  assert.deepEqual(refused, []);
  assert.deepEqual(ignored, []);
});

test("tool policy supports auto and none but refuses guarantees it cannot provide", () => {
  const tool = {
    type: "function",
    function: {
      name: "lookup",
      parameters: {
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
      },
    },
  };
  assert.deepEqual(normalizeToolPolicy({ tools: [tool], tool_choice: "auto" }).tools, [tool]);
  assert.deepEqual(normalizeToolPolicy({ tools: [tool], tool_choice: "none" }).tools, []);
  for (const tool_choice of ["required", { type: "function", function: { name: "lookup" } }]) {
    assert.throws(() => normalizeToolPolicy({ tools: [tool], tool_choice }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "unsupported_parameter");
      return true;
    });
  }
});

test("tool policy refuses strict, hosted, malformed, and duplicate tools", () => {
  const bad = [
    [{ type: "web_search_preview" }],
    [{ type: "function", function: { name: "" } }],
    [{ type: "function", function: { name: "x", parameters: [] } }],
    [{ type: "function", function: { name: "x", strict: true } }],
    [{ type: "function", function: { name: "x", future: true } }],
    [{ type: "function", function: { name: "x", parameters: {}, future: true } }],
    [
      { type: "function", function: { name: "x" } },
      { type: "function", function: { name: "x" } },
    ],
  ];
  for (const tools of bad) assert.throws(() => normalizeToolPolicy({ tools }), /tool|duplicate|strict/i);
  assert.throws(() => normalizeToolPolicy({ tools: {} }), /must be an array/);
});

test("Responses tool JSON Schema keeps nested parameters intact", () => {
  const tool = {
    type: "function",
    name: "lookup",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
        },
      },
    },
  };
  assert.deepEqual(normalizeToolPolicy({ tools: [tool] }, "responses").tools, [tool]);
});

test("parameters that would still change the meaning are refused", () => {
  for (const key of ["response_format", "audio", "modalities", "web_search_options"]) {
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

test("unknown nested parameters are reported with stable dotted paths", () => {
  assert.deepEqual(
    ignoredNestedKeys({ summary: "auto", effort: "high", future: true }, "reasoning", new Set(["effort"])),
    ["reasoning.future", "reasoning.summary"],
  );
  assert.deepEqual(ignoredNestedKeys(null, "reasoning", new Set()), []);
});

test("natively handled and emulated parameters are neither ignored nor refused", () => {
  const c = classify({
    ...base,
    stream: true,
    max_tokens: 10,
    stop: ["x"],
    stream_options: {},
    reasoning_effort: "high",
    tools: [],
    tool_choice: "none",
  });
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

test("parseChatRequest refuses what is left and normalizes tool policy", () => {
  assert.throws(() => parseChatRequest({ ...base, response_format: {} }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /`response_format` is not supported/);
    return true;
  });
  assert.deepEqual(parseChatRequest({ ...base, tools: [], tool_choice: "none" }).ignored, []);
  assert.deepEqual(parseChatRequest({ ...base, tools: [], tool_choice: "none" }).tools, []);
});

test("parseChatRequest surfaces the emulated knobs and validates them", () => {
  const r = parseChatRequest({
    ...base,
    max_tokens: 5,
    stop: "END",
    stream_options: { include_usage: true, future_option: 1 },
    reasoning_effort: "high",
  });
  assert.equal(r.maxTokens, 5);
  assert.deepEqual(r.stop, ["END"]);
  assert.equal(r.includeUsage, true);
  assert.equal(r.reasoning, "high");
  assert.deepEqual(r.ignored, ["stream_options.future_option"]);
  // max_completion_tokens is the current spelling and wins over the legacy one.
  assert.equal(parseChatRequest({ ...base, max_tokens: 5, max_completion_tokens: 9 }).maxTokens, 9);
  assert.throws(() => parseChatRequest({ ...base, max_tokens: 0 }), /positive integer/);
  assert.throws(() => parseChatRequest({ ...base, stop: [""] }), /non-empty string/);
  assert.throws(() => parseChatRequest({ ...base, stream: "true" }), /must be a boolean/);
  assert.throws(() => parseChatRequest({ ...base, stream_options: [] }), /must be an object/);
  assert.throws(() => parseChatRequest({ ...base, stream_options: { include_usage: 1 } }), /must be a boolean/);
  assert.throws(() => parseChatRequest({ ...base, reasoning_effort: 3 }), /non-empty string/);
});

test("no limiter is built when nothing needs limiting", () => {
  assert.equal(makeLimiter({ maxTokens: null, stop: [] }), null);
});

test("a stop sequence cuts the text and excludes itself", () => {
  const limit = makeLimiter({ maxTokens: null, stop: ["STOP"] });
  assert.equal(limit("all good so far"), null);
  assert.equal(limit.visibleText("keep this ST"), "keep this ");
  assert.deepEqual(limit("keep this STOP drop this"), { stopReason: "end_turn", text: "keep this " });
});

test("the earliest stop in the text wins, independent of array order", () => {
  const limit = makeLimiter({ maxTokens: null, stop: ["END", "STOP"] });
  assert.deepEqual(limit("abcSTOP xyzEND"), { stopReason: "end_turn", text: "abc" });
});

test("the earlier of a stop and the visible length cutoff wins", () => {
  const limit = makeLimiter({ maxTokens: 2, stop: ["STOP"] });
  assert.deepEqual(limit("123STOP999"), { stopReason: "end_turn", text: "123" });
  assert.deepEqual(limit("12345678STOP"), { stopReason: "max_tokens", text: "12345678" });
});

test("max_tokens truncates and reports length", () => {
  const limit = makeLimiter({ maxTokens: 2, stop: [] });
  assert.equal(limit("12345678"), null); // exactly 2 tokens by the estimate
  const cut = limit("123456789");
  assert.equal(cut.stopReason, "max_tokens");
  assert.equal(cut.text.length, 8);
});

test("max_tokens never splits a Unicode surrogate pair", () => {
  const limit = makeLimiter({ maxTokens: 1, stop: [] });
  const cut = limit("😀😀😀😀😀");
  assert.deepEqual(cut, { stopReason: "max_tokens", text: "😀😀😀😀" });
  assert.equal(cut.text.includes("\uFFFD"), false);
});

test("the token estimate is documented as approximate, and monotonic", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.ok(estimateTokens("a".repeat(100)) > estimateTokens("a".repeat(50)));
});
