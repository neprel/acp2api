import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalMessage, fingerprint } from "../src/sessions.js";

test("a string and one text part are the same semantic message", () => {
  const string = { role: "user", content: "hello" };
  const parts = { role: "user", content: [{ type: "text", text: "hello" }] };

  assert.deepEqual(canonicalMessage(string), canonicalMessage(parts));
  assert.equal(fingerprint(string), fingerprint(parts));
});

test("unknown message and part fields do not change identity", () => {
  const plain = { role: "user", content: [{ type: "text", text: "hello" }] };
  const annotated = {
    role: "user",
    content: [{ type: "text", text: "hello", provider_annotation: { trace: 1 } }],
    refusal: null,
    provider_annotation: "ignored",
  };

  assert.equal(fingerprint(plain), fingerprint(annotated));
});

test("multi-part order remains conversation identity", () => {
  const one = { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] };
  const two = { role: "user", content: [{ type: "text", text: "two" }, { type: "text", text: "one" }] };

  assert.notEqual(fingerprint(one), fingerprint(two));
});

test("different text never collides through normalization", () => {
  assert.notEqual(
    fingerprint({ role: "user", content: "hello" }),
    fingerprint({ role: "user", content: "hello " }),
  );
});

test("streaming tool-call index is transport metadata", () => {
  const call = {
    id: "call_1",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"a"}' },
  };

  assert.equal(
    fingerprint({ role: "assistant", content: null, tool_calls: [call] }),
    fingerprint({ role: "assistant", content: null, tool_calls: [{ index: 0, ...call }] }),
  );
});

test("function arguments remain a raw string", () => {
  const call = (arguments_) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: arguments_ } }],
  });

  assert.notEqual(fingerprint(call('{"path":"a"}')), fingerprint(call('{ "path": "a" }')));
});
