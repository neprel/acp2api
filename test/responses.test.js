import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent } from "../src/agent.js";
import { normalizeConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { parseResponsesRequest, responseObject, toInputBlocks } from "../src/responses.js";
import { SessionStore } from "../src/sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "fake-agent.js");

async function start(t, { server: serverOpts } = {}) {
  const config = normalizeConfig(
    {
      server: { host: "127.0.0.1", cwd: here, ...serverOpts },
      agents: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }],
    },
    { baseDir: here, env: {} },
  );
  const s = createServer(config, { agents: new Map(config.agents.map((a) => [a.name, new Agent(a, config.server)])) });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  const base = `http://127.0.0.1:${s.address().port}`;
  return (path, init = {}) => fetch(base + path, { headers: { "content-type": "application/json" }, ...init });
}

const post = (body) => ({ method: "POST", body: JSON.stringify(body) });

test("input accepts a bare string, messages, and typed input_text parts", () => {
  assert.deepEqual(toInputBlocks("hi"), [{ type: "text", text: "hi" }]);
  assert.deepEqual(toInputBlocks([{ role: "user", content: "hi" }]), [{ type: "text", text: "hi" }]);
  assert.deepEqual(toInputBlocks([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]), [
    { type: "text", text: "hi" },
  ]);
  // instructions are the system preamble, prepended and unlabelled
  assert.deepEqual(toInputBlocks("hi", "be terse"), [{ type: "text", text: "be terse\n\nhi" }]);
  assert.throws(() => toInputBlocks(42), /`input` must be a string or an array/);
  assert.throws(() => toInputBlocks([{ type: "function_call" }]), /are not supported/);
});

test("parseResponsesRequest maps the fields ACP can carry", () => {
  const r = parseResponsesRequest({
    model: "m",
    input: "hi",
    instructions: "sys",
    previous_response_id: "resp_1",
    reasoning: { effort: "high" },
    max_output_tokens: 50,
    stream: true,
  });
  assert.equal(r.model, "m");
  assert.equal(r.instructions, "sys");
  assert.equal(r.previousResponseId, "resp_1");
  // The one genuinely per-request agent setting -- chat completions has no field for it.
  assert.equal(r.reasoning, "high");
  assert.equal(r.maxTokens, 50);
  assert.equal(r.stream, true);
  // OpenAI stores by default and so must we, or previous_response_id could never work.
  assert.equal(r.store, true);
  assert.equal(parseResponsesRequest({ model: "m", input: "hi", store: false }).store, false);
});

test("tools and text.format are refused; style parameters are ignored", () => {
  assert.throws(() => parseResponsesRequest({ model: "m", input: "hi", tools: [] }), /`tools` is not supported/);
  assert.throws(() => parseResponsesRequest({ model: "m", input: "hi", text: {} }), /structured output/);
  assert.deepEqual(parseResponsesRequest({ model: "m", input: "hi", temperature: 0 }).ignored, ["temperature"]);
  assert.throws(() => parseResponsesRequest({ model: "m", input: "hi", max_output_tokens: 0 }), /positive integer/);
});

test("responseObject maps stop reasons to status and incomplete_details", () => {
  const meta = { id: "resp_1", model: "m", created: 1, store: true };
  const ok = responseObject({ ...meta, text: "hi", reasoning: "", stopReason: "end_turn", usage: null });
  assert.equal(ok.status, "completed");
  assert.equal(ok.incomplete_details, null);
  assert.equal(ok.output_text, "hi");
  assert.equal(ok.output.length, 1);

  const cut = responseObject({ ...meta, text: "hi", reasoning: "why", stopReason: "max_tokens", usage: null });
  assert.equal(cut.status, "incomplete");
  assert.deepEqual(cut.incomplete_details, { reason: "max_output_tokens" });
  // Reasoning becomes its own output item, ahead of the message.
  assert.equal(cut.output[0].type, "reasoning");
  assert.equal(cut.output[0].summary[0].text, "why");
  assert.equal(cut.output[1].type, "message");
});

test("a response is created, stored, fetched and deleted", async (t) => {
  const call = await start(t);
  const created = await (await call("/v1/responses", post({ model: "fake", input: "hello" }))).json();
  assert.equal(created.object, "response");
  assert.equal(created.status, "completed");
  assert.equal(created.output_text, "[fast] hello");
  assert.equal(created.previous_response_id, null);

  const fetched = await (await call(`/v1/responses/${created.id}`)).json();
  assert.deepEqual(fetched, created);

  const deleted = await (await call(`/v1/responses/${created.id}`, { method: "DELETE" })).json();
  assert.deepEqual(deleted, { id: created.id, object: "response.deleted", deleted: true });
  assert.equal((await call(`/v1/responses/${created.id}`)).status, 404);
});

test("previous_response_id continues in the SAME ACP session", async (t) => {
  const call = await start(t);
  const first = await (await call("/v1/responses", post({ model: "fake", input: "one" }))).json();
  const second = await (await call("/v1/responses", post({ model: "fake", input: "two", previous_response_id: first.id }))).json();

  assert.equal(second.previous_response_id, first.id);
  // The fixture names sessions s1, s2, ... -- a second session would mean the
  // conversation was not continued but restarted, and the agent would have lost
  // everything the caller expected it to remember.
  const ids = await (await call("/v1/responses", post({ model: "fake", input: "ECHOSESSION", previous_response_id: second.id }))).json();
  assert.equal(ids.output_text, "s1");
});

test("a chain can be continued from any response in it, not only its tip", async (t) => {
  const call = await start(t);
  const first = await (await call("/v1/responses", post({ model: "fake", input: "one" }))).json();
  await call("/v1/responses", post({ model: "fake", input: "two", previous_response_id: first.id }));
  const branched = await call("/v1/responses", post({ model: "fake", input: "three", previous_response_id: first.id }));
  assert.equal(branched.status, 200);
});

test("an unknown or expired previous_response_id is 404, and a mismatched model 400", async (t) => {
  const call = await start(t);
  const missing = await call("/v1/responses", post({ model: "fake", input: "x", previous_response_id: "resp_nope" }));
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error.message, /unknown or its session has expired/);
});

test("store: false answers but retains nothing", async (t) => {
  const call = await start(t);
  const res = await (await call("/v1/responses", post({ model: "fake", input: "hi", store: false }))).json();
  assert.equal(res.output_text, "[fast] hi");
  // Nothing to fetch and nothing to continue -- the session was closed with the turn.
  assert.equal((await call(`/v1/responses/${res.id}`)).status, 404);
});

test("reasoning.effort is applied per request, on a live conversation", async (t) => {
  const call = await start(t);
  const low = await (await call("/v1/responses", post({ model: "fake", input: "hi", reasoning: { effort: "low" } }))).json();
  assert.equal(low.output[0].summary[0].text, "thinking(low)");
  // Raised for one hard question on the SAME session -- impossible in chat completions.
  const high = await (
    await call("/v1/responses", post({ model: "fake", input: "hi", reasoning: { effort: "high" }, previous_response_id: low.id }))
  ).json();
  assert.equal(high.output[0].summary[0].text, "thinking(high)");
});

test("max_output_tokens produces status incomplete", async (t) => {
  const call = await start(t);
  const res = await (await call("/v1/responses", post({ model: "fake", input: "COUNT", max_output_tokens: 3 }))).json();
  assert.equal(res.status, "incomplete");
  assert.deepEqual(res.incomplete_details, { reason: "max_output_tokens" });
});

test("a quota failure is 429 here too", async (t) => {
  const call = await start(t);
  const res = await call("/v1/responses", post({ model: "fake", input: "QUOTA" }));
  assert.equal(res.status, 429);
});

test("the event stream is typed, ordered and terminated", async (t) => {
  const call = await start(t);
  const res = await call("/v1/responses", post({ model: "fake", input: "hello", stream: true }));
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const frames = (await res.text()).split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));
  assert.equal(frames.at(-1), "[DONE]");
  const events = frames.slice(0, -1).map((f) => JSON.parse(f));

  assert.deepEqual(
    events.map((e) => e.type).filter((t, i, a) => a.indexOf(t) === i),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ],
  );
  // sequence_number is what a consumer uses to detect a gap, so it must be dense.
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
  // An item is opened before its parts and closed after them; indices increase.
  const added = events.filter((e) => e.type === "response.output_item.added");
  assert.deepEqual(added.map((e) => e.output_index), [0, 1]);
  assert.equal(events.at(-1).response.output_text, "[fast] hello");
});

test("the store parks a conversation on expiry and on eviction", async () => {
  const closed = [];
  const agents = new Map([["a", { closeSession: (s) => closed.push(s.id) }]]);
  let clock = 1000;
  const store = new SessionStore({ max: 2, ttlMs: 100, now: () => clock });

  const c1 = store.open("a", { id: "s1" });
  store.record(c1, "resp_1", {});
  clock += 200; // c1 is now stale
  const c2 = store.open("a", { id: "s2" });
  store.record(c2, "resp_2", {});
  await store.prune(agents);

  // The expensive half went: the ACP session was closed and its login freed. The
  // conversation did NOT go -- it still resolves, carrying the id to resume from.
  assert.deepEqual(closed, ["s1"]);
  const parked = store.find("resp_1");
  assert.equal(parked.session, null, "a parked conversation holds no live session");
  assert.equal(parked.sessionId, "s1", "and keeps the id that can restore it");

  // Eviction is by LAST USE, not by age: c2 is the oldest conversation here, but
  // continuing it must save it from the cap while a newer idle one goes instead.
  clock += 10;
  const c3 = store.open("a", { id: "s3" });
  store.record(c3, "resp_3", {});
  clock += 10;
  const c4 = store.open("a", { id: "s4" });
  store.record(c4, "resp_4", {});
  clock += 10;
  store.find("resp_2");
  await store.prune(agents);
  assert.deepEqual(closed, ["s1", "s3"]);
});

test("the cap counts resident sessions, not conversations", async () => {
  // Parked conversations hold no process, so a store full of them is not under the
  // pressure the cap exists to relieve. Counting them would evict live work to make
  // room for records.
  const closed = [];
  const agents = new Map([["a", { closeSession: (s) => closed.push(s.id) }]]);
  let clock = 1000;
  const store = new SessionStore({ max: 2, ttlMs: 100, now: () => clock });

  const old = store.open("a", { id: "s1" });
  store.record(old, "resp_1", {});
  clock += 200;
  await store.prune(agents); // s1 parks
  assert.deepEqual(closed, ["s1"]);

  store.record(store.open("a", { id: "s2" }), "resp_2", {});
  store.record(store.open("a", { id: "s3" }), "resp_3", {});
  await store.prune(agents);
  // Two live sessions and one parked record: the cap of 2 is met, and nothing else
  // was taken to make room for a conversation that costs nothing.
  assert.deepEqual(closed, ["s1"]);
});

test("a conversation nobody returns to is eventually forgotten, not parked forever", async () => {
  const closed = [];
  const agents = new Map([["a", { closeSession: (s) => closed.push(s.id) }]]);
  let clock = 1000;
  const store = new SessionStore({ ttlMs: 100, forgetTtlMs: 1000, now: () => clock });

  const c1 = store.open("a", { id: "s1" });
  store.record(c1, "resp_1", {});
  clock += 200;
  await store.prune(agents);
  // `find` refreshes the conversation, so the forget bound runs from here.
  assert.ok(store.find("resp_1"), "still a conversation, just parked");

  clock += 1001;
  await store.prune(agents);
  assert.equal(store.find("resp_1"), null, "past the forget bound it is genuinely gone");
});

test("forgetting one response of a chain keeps the conversation alive", async () => {
  const closed = [];
  const agents = new Map([["a", { closeSession: (s) => closed.push(s.id) }]]);
  const store = new SessionStore({});
  const conv = store.open("a", { id: "s1" });
  store.record(conv, "resp_1", {});
  store.record(conv, "resp_2", {});

  await store.forget("resp_1", agents);
  assert.deepEqual(closed, []);
  assert.ok(store.find("resp_2"));
  // ...and the last one takes the session with it.
  await store.forget("resp_2", agents);
  assert.deepEqual(closed, ["s1"]);
});
