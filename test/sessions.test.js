import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMessage,
  fingerprint,
  ResponseStorageError,
  SessionCapacityError,
  SessionStore,
} from "../src/sessions.js";

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

const registry = (closed = []) => new Map([
  ["agent", { closeSession: async (session) => closed.push(session.id) }],
]);

test("only the latest response can atomically own a continuation", () => {
  const store = new SessionStore();
  const convId = store.open("agent", { id: "session-1" });
  store.record(convId, "resp_1", { id: "resp_1" });
  store.record(convId, "resp_2", { id: "resp_2" });

  assert.equal(store.response("resp_1").id, "resp_1", "old snapshots remain readable");
  assert.equal(store.claimResponse("resp_1").continuation, "stale");

  const owner = store.claimResponse("resp_2");
  assert.equal(owner.continuation, "claimed");
  assert.equal(store.claimResponse("resp_2").continuation, "busy");
  assert.equal(store.releaseResponseClaim(convId, "not-the-owner"), false);
  assert.equal(store.claimResponse("resp_2").continuation, "busy");
  assert.equal(store.releaseResponseClaim(convId, owner.claimId), true);
  assert.equal(store.claimResponse("resp_2").continuation, "claimed");
});

test("an expired response is rejected before a stale lookup can refresh it", () => {
  let now = 0;
  const store = new SessionStore({ ttlMs: 2, forgetTtlMs: 10, now: () => now });
  const convId = store.open("agent", { id: "session-1" });
  store.record(convId, "resp_1", {});
  now = 1;
  store.record(convId, "resp_2", {});

  now = 9;
  assert.equal(store.claimResponse("resp_1").continuation, "stale");
  now = 11;
  assert.equal(store.claimResponse("resp_2"), null, "stale access did not extend the deadline");
});

test("resume identity and instructions survive parking", async () => {
  let now = 0;
  const closed = [];
  const store = new SessionStore({ ttlMs: 5, forgetTtlMs: 50, now: () => now });
  const resumeContext = {
    mcpServers: [{ name: "caller-bench" }],
  };
  const convId = store.open("agent", { id: "session-1" }, {
    instructions: "Be exact",
    resumeContext,
  });
  store.record(convId, "resp_1", {});
  now = 6;
  await store.prune(registry(closed));

  const claimed = store.claimResponse("resp_1");
  assert.equal(claimed.continuation, "claimed");
  assert.equal(claimed.instructions, "Be exact");
  assert.deepEqual(claimed.resumeContext, resumeContext);
  assert.equal(claimed.session, null);
  assert.deepEqual(closed, ["session-1"]);
});

test("response storage is finite and evicts only non-tip snapshots", () => {
  const store = new SessionStore({ maxResponses: 2, maxResponseBytes: 1_000 });
  const first = store.open("agent", { id: "session-1" });
  store.record(first, "resp_1", { value: "old" });
  store.record(first, "resp_2", { value: "tip-1" });
  const second = store.open("agent", { id: "session-2" });
  store.record(second, "resp_3", { value: "tip-2" });

  assert.equal(store.responseCount, 2);
  assert.equal(store.response("resp_1"), null, "oldest stale snapshot was evicted");
  assert.equal(store.response("resp_2").value, "tip-1");
  assert.equal(store.response("resp_3").value, "tip-2");

  const third = store.open("agent", { id: "session-3" });
  assert.throws(
    () => store.record(third, "resp_4", { value: "cannot evict another chain's tip" }),
    (error) => error instanceof ResponseStorageError && error.status === 507 && error.code === "response_storage_full",
  );
  assert.equal(store.responseCount, 2, "a rejected record does not partially mutate storage");
});

test("an oversized response fails before replacing the current tip", () => {
  const store = new SessionStore({ maxResponseBytes: 40 });
  const convId = store.open("agent", { id: "session-1" });
  store.record(convId, "resp_1", { text: "ok" });
  const before = store.responseBytes;

  assert.throws(
    () => store.record(convId, "resp_2", { text: "x".repeat(100) }),
    ResponseStorageError,
  );
  assert.equal(store.responseBytes, before);
  assert.equal(store.claimResponse("resp_1").continuation, "claimed");
});

test("response admission stores the immutable JSON snapshot whose bytes were counted", () => {
  const store = new SessionStore({ maxResponseBytes: 1_000 });
  const convId = store.open("agent", { id: "session-1" });
  const response = { id: "resp_1", output: [{ type: "message", content: [{ text: "before" }] }] };
  const admittedBytes = Buffer.byteLength(JSON.stringify(response));

  store.record(convId, response.id, response);
  response.output[0].content[0].text = "after".repeat(100);
  response.output.push({ type: "reasoning", summary: [{ text: "not admitted" }] });

  const stored = store.response(response.id);
  assert.equal(store.responseBytes, admittedBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(stored)), admittedBytes);
  assert.equal(stored.output[0].content[0].text, "before");
  assert.equal(stored.output.length, 1);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.output[0].content[0]));
});

test("conversation admission evicts idle LRU and refuses all-active capacity", async () => {
  const closed = [];
  let now = 0;
  const store = new SessionStore({ maxConversations: 1, now: () => now });
  store.open("agent", { id: "idle" });
  const admission = await store.prepareOpen(registry(closed));
  assert.deepEqual(closed, ["idle"]);

  const active = store.open("agent", { id: "active" }, { admissionId: admission });
  assert.equal(store.claim(active), true);
  await assert.rejects(
    store.prepareOpen(registry(closed)),
    (error) => error instanceof SessionCapacityError && error.status === 503 && error.code === "session_capacity",
  );
  assert.throws(() => store.open("agent", { id: "overflow" }), SessionCapacityError);
});

test("conversation admission is reserved across asynchronous session opening", async () => {
  const store = new SessionStore({ maxConversations: 1 });
  const admission = await store.prepareOpen(registry());
  await assert.rejects(store.prepareOpen(registry()), SessionCapacityError);
  assert.equal(store.cancelOpen(admission), true);

  const replacement = await store.prepareOpen(registry());
  store.open("agent", { id: "session-1" }, { admissionId: replacement });
  assert.equal(store.cancelOpen(replacement), false, "an admission is consumed exactly once");

  const closed = [];
  const contended = new SessionStore({ maxConversations: 1 });
  contended.open("agent", { id: "idle" });
  const first = contended.prepareOpen(registry(closed));
  const second = contended.prepareOpen(registry(closed));
  const firstAdmission = await first;
  await assert.rejects(second, SessionCapacityError);
  assert.deepEqual(closed, ["idle"], "serialized admission evicts the idle record once");
  contended.cancelOpen(firstAdmission);
});

test("store:false termination closes the chain but preserves old GET snapshots", async () => {
  const closed = [];
  const closedConversations = [];
  const store = new SessionStore({ onClose: (conv) => closedConversations.push(conv.bench) });
  const convId = store.open("agent", { id: "session-1" }, { bench: "bench-1" });
  store.record(convId, "resp_1", { id: "resp_1" });

  await store.finishUnstored(convId, registry(closed));
  assert.equal(store.claimResponse("resp_1"), null);
  assert.deepEqual(store.response("resp_1"), { id: "resp_1" });
  assert.deepEqual(closed, ["session-1"]);
  assert.deepEqual(closedConversations, ["bench-1"]);
});

test("cleanup is non-overlapping and shutdown stops periodic cleanup", async () => {
  let releaseClose;
  let closeCalls = 0;
  let now = 0;
  const agents = new Map([["agent", {
    closeSession: async () => {
      closeCalls += 1;
      await new Promise((resolve) => { releaseClose = resolve; });
    },
  }]]);
  const store = new SessionStore({ ttlMs: 1, forgetTtlMs: 10, now: () => now });
  store.open("agent", { id: "session-1" });
  now = 2;
  const first = store.cleanup(agents);
  const second = store.cleanup(agents);
  assert.equal(first, second);
  assert.equal(closeCalls, 1);
  releaseClose();
  await first;

  assert.equal(store.startCleanup(agents, { intervalMs: 5 }), true);
  await store.closeAll(agents);
  assert.equal(store.startCleanup(agents, { intervalMs: 5 }), false);
  assert.throws(() => store.open("agent", { id: "after-close" }), SessionCapacityError);
});
