import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, AgentError, selectValues } from "../src/agent.js";
import { normalizeConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "fake-agent.js");

/** Builds a real Agent wired to the fixture over real stdio. */
function makeAgent(overrides = {}) {
  const config = normalizeConfig(
    {
      server: { cwd: here, ...(overrides.server ?? {}) },
      agents: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE], ...overrides.agent }],
    },
    { baseDir: here, env: {} },
  );
  return new Agent(config.agents[0], config.server);
}

test("selectValues handles both flat and grouped option lists", () => {
  assert.deepEqual(selectValues([{ value: "a", name: "A" }]), [{ value: "a", name: "A" }]);
  assert.deepEqual(
    selectValues([{ group: "g", name: "G", options: [{ value: "a", name: "A" }] }]),
    [{ value: "a", name: "A" }],
  );
  assert.deepEqual(selectValues(undefined), []);
});

test("a prompt turn streams reasoning and text, then reports usage", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());

  const events = [];
  const turn = await agent.prompt([{ type: "text", text: "hello" }], { onEvent: (e) => events.push(e) });

  assert.equal(turn.text, "[fast] hello");
  assert.equal(turn.reasoning, "thinking(low)");
  assert.equal(turn.stopReason, "end_turn");
  assert.deepEqual(turn.usage, { inputTokens: 11, outputTokens: 22, totalTokens: 33, thoughtTokens: 3 });
  // Streamed incrementally, and the tool_call update is not mistaken for content.
  assert.deepEqual(events, [
    { type: "reasoning", delta: "thinking(low)" },
    { type: "text", delta: "[fast] " },
    { type: "text", delta: "hello" },
  ]);
});

test("model and reasoning are applied by category, not by option id", async (t) => {
  // The fixture names its thought_level option `effort`; nothing in the config says so.
  const agent = makeAgent({ agent: { model: "smart", reasoning: "high" } });
  t.after(() => agent.close());
  const turn = await agent.prompt([{ type: "text", text: "hi" }]);
  assert.equal(turn.text, "[smart] hi");
  assert.equal(turn.reasoning, "thinking(high)");
});

test("raw options address an id directly, including booleans", async (t) => {
  const agent = makeAgent({ agent: { options: { verbose: true, model: "smart" } } });
  t.after(() => agent.close());
  assert.equal((await agent.prompt([{ type: "text", text: "hi" }])).text, "[smart] hi");
});

test("an unavailable model is a 400, not a silent fallback", async (t) => {
  const agent = makeAgent({ agent: { model: "gpt-9" } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "hi" }]), (e) => {
    assert.ok(e instanceof AgentError);
    assert.equal(e.status, 400);
    assert.match(e.message, /no value "gpt-9"/);
    return true;
  });
});

test("an unknown config option id is rejected", async (t) => {
  const agent = makeAgent({ agent: { options: { nonesuch: "x" } } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "hi" }]), /offers no config option "nonesuch"/);
});

test("the option set is re-read after each set, because picking a model changes it", async (t) => {
  // Selecting "lite" removes the thought_level selector, exactly as claude-agent-acp
  // does for Haiku. Resolving the reasoning option id up front would look it up in a
  // list it is no longer in, and fail with a nonsense message.
  const agent = makeAgent({ agent: { model: "lite", reasoning: "high" } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "hi" }]), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /offers no thought_level selector/);
    return true;
  });
});

test("a model with no reasoning selector works when none is asked for", async (t) => {
  const agent = makeAgent({ agent: { model: "lite" } });
  t.after(() => agent.close());
  assert.equal((await agent.prompt([{ type: "text", text: "hi" }])).text, "[lite] hi");
});

test("quota exhaustion becomes 429 and an unrelated failure stays 502", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());

  await assert.rejects(agent.prompt([{ type: "text", text: "QUOTA" }]), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, "rate_limit_exceeded");
    return true;
  });
  // The distinction that matters: a router must not spend its next provider on a
  // crash it should have retried instead.
  await assert.rejects(agent.prompt([{ type: "text", text: "BOOM" }]), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.code, "agent_error");
    return true;
  });
});

test("limitPatterns are configurable", async (t) => {
  const agent = makeAgent({ server: { limitPatterns: ["reset by peer"] } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "BOOM" }]), (e) => e.status === 429);
  await assert.rejects(agent.prompt([{ type: "text", text: "QUOTA" }]), (e) => e.status === 502);
});

test("aborting the request cancels the turn in the agent", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());
  const controller = new AbortController();
  const pending = agent.prompt([{ type: "text", text: "HANG" }], { signal: controller.signal });
  // Wait until the agent is demonstrably mid-turn before cancelling.
  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  assert.equal((await pending).stopReason, "cancelled");
});

test("the child process is reused across turns and shut down on close", async () => {
  const agent = makeAgent();
  const first = await agent.prompt([{ type: "text", text: "one" }]);
  const second = await agent.prompt([{ type: "text", text: "two" }]);
  assert.equal(first.text, "[fast] one");
  assert.equal(second.text, "[fast] two");
  await agent.close();
  // close() is terminal: a late request must be refused, not answered by a fresh
  // CLI that nothing is left to shut down.
  await assert.rejects(agent.prompt([{ type: "text", text: "x" }]), (e) => {
    assert.equal(e.status, 503);
    assert.match(e.message, /shut down/);
    return true;
  });
});

test("a command that cannot be spawned is 503, not a crash", async (t) => {
  const agent = makeAgent({ agent: { command: "definitely-not-a-real-binary-xyz" } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "hi" }]), (e) => {
    assert.equal(e.status, 503);
    assert.equal(e.code, "agent_unavailable");
    return true;
  });
});
