import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, AgentError, selectValues } from "../src/agent.js";
import { normalizeConfig } from "../src/config.js";
import { makeLimiter } from "../src/openai.js";

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
  // Streamed incrementally, with the tool call reported as progress rather than
  // folded into the answer.
  assert.deepEqual(events, [
    { type: "reasoning", delta: "thinking(low)" },
    { type: "tool_call", id: "t1", title: "noop", status: "completed", kind: "other" },
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

test("mcpServers from config reach session/new in ACP's own shape", async (t) => {
  // Tools belong to the agent, not the request: this is the only way an ACP agent
  // gets them. The conversion is the part worth proving -- ACP takes env and
  // headers as [{name, value}] arrays, which nobody writes by hand.
  const agent = makeAgent({
    agent: {
      mcpServers: [
        { name: "http-one", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" } },
        { name: "stdio-one", command: "/bin/true", env: { K: "v" } },
      ],
    },
  });
  t.after(() => agent.close());

  assert.deepEqual(JSON.parse((await agent.prompt([{ type: "text", text: "ECHOMCP" }])).text), [
    { type: "http", name: "http-one", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
    { name: "stdio-one", command: "/bin/true", args: [], env: [{ name: "K", value: "v" }] },
  ]);
});

test("max_tokens cuts the turn short and reports it", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());
  const turn = await agent.prompt([{ type: "text", text: "COUNT" }], {
    limit: makeLimiter({ maxTokens: 3, stop: [] }),
  });
  assert.equal(turn.stopReason, "max_tokens");
  assert.ok(turn.text.length <= 12, `expected a truncated answer, got ${turn.text.length} chars`);
});

test("a stop sequence cuts the turn and excludes itself", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());
  const turn = await agent.prompt([{ type: "text", text: "COUNT" }], {
    limit: makeLimiter({ maxTokens: null, stop: ["word4"] }),
  });
  assert.equal(turn.stopReason, "end_turn");
  assert.equal(turn.text, "word1 word2 word3 ");
});

test("nothing past the cut is streamed", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());
  const seen = [];
  const turn = await agent.prompt([{ type: "text", text: "COUNT" }], {
    limit: makeLimiter({ maxTokens: null, stop: ["word3"] }),
    onEvent: (e) => e.type === "text" && seen.push(e.delta),
  });
  assert.equal(seen.join(""), turn.text);
  assert.ok(!seen.join("").includes("word3"));
});

test("the agent's own tool calls surface as progress, not as content", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());
  const events = [];
  const turn = await agent.prompt([{ type: "text", text: "hi" }], { onEvent: (e) => events.push(e) });
  const tools = events.filter((e) => e.type === "tool_call");
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], { type: "tool_call", id: "t1", title: "noop", status: "completed", kind: "other" });
  assert.ok(!turn.text.includes("noop"));
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
