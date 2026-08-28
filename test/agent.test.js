import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  return new Agent(config.agents[0], config.server, overrides.log);
}

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "acp2api-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
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
  // Raw ACP counters, passed through untouched: these are SESSION totals, and
  // turning them into what one turn cost belongs to the server, not to this layer.
  assert.deepEqual(turn.usage, {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    thoughtTokens: 3,
    cachedReadTokens: 0,
    cachedWriteTokens: 11,
  });
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

test("an unavailable selector value names every offered value", async (t) => {
  const agent = makeAgent({ agent: { model: "opus" } });
  t.after(() => agent.close());
  await assert.rejects(
    agent.prompt([{ type: "text", text: "hi" }]),
    /"model" has no value "opus"; offered: fast, smart, lite/,
  );
});

test("an unknown config option id is rejected", async (t) => {
  const agent = makeAgent({ agent: { options: { nonesuch: "x" } } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "hi" }]), /offers no config option "nonesuch"/);
});

test("a configured model is rejected when the agent advertises no config options", async (t) => {
  const agent = makeAgent({ agent: { model: "smart", env: { NO_CONFIG_OPTIONS: "1" } } });
  t.after(() => agent.close());
  await assert.rejects(agent.prompt([{ type: "text", text: "hi" }]), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "unsupported_option");
    assert.match(error.message, /offers no model selector/);
    return true;
  });
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
  // Cancelled on the agent's FIRST sign of life, not after a fixed wait. Two
  // hundred milliseconds is not enough to spawn a process on a two-core runner,
  // so the abort landed before the turn existed -- and a signal that is already
  // aborted notifies nobody who listens afterwards, so the turn ran on with
  // nobody waiting and the test file never exited. Five minutes of CI, and a log
  // that just stopped.
  let began;
  const started = new Promise((r) => (began = r));
  const pending = agent.prompt([{ type: "text", text: "HANG" }], {
    signal: controller.signal,
    onEvent: () => began(),
  });
  await started;
  controller.abort();
  assert.equal((await pending).stopReason, "cancelled");
});

test("a child that ignores cancel is bounded and its session is dead", async (t) => {
  const agent = makeAgent({ server: { agentRpcTimeoutMs: 2_000 } });
  t.after(() => agent.close());
  const session = await agent.openSession();
  const started = Date.now();
  const turn = await agent.turn(session, [{ type: "text", text: "IGNORE_CANCEL" }], {
    limit: makeLimiter({ maxTokens: 1, stop: [] }),
  });

  assert.equal(turn.stopReason, "max_tokens");
  assert.ok(Date.now() - started < 3_000, "the post-cancel drain must use its grace deadline");
  await assert.rejects(
    agent.turn(session, [{ type: "text", text: "must not run" }]),
    (error) => error.status === 502 && /no longer usable/.test(error.message),
  );
});

test("a hung session/close is bounded and swallowed", async (t) => {
  const agent = makeAgent({ server: { agentRpcTimeoutMs: 10_000 } });
  t.after(() => agent.close());
  const warm = await agent.openSession();
  await agent.closeSession(warm);
  const started = Date.now();
  const turn = await agent.prompt([{ type: "text", text: "HANG_CLOSE" }]);

  assert.equal(turn.text, "[fast] HANG_CLOSE");
  assert.ok(Date.now() - started < 2_000, "best-effort session close must not block the caller");
});

test("shutdown escalates past trapped SIGTERM and leaves no child", async (t) => {
  const dir = await temporary(t);
  const pidFile = join(dir, "pid");
  const agent = makeAgent({ agent: { env: { PID_FILE: pidFile, TRAP_SIGTERM: "1" } } });
  const session = await agent.openSession();
  assert.equal(session.id, "s1");
  const pid = Number(await readFile(pidFile, "utf8"));
  const started = Date.now();

  await agent.close();

  assert.ok(Date.now() - started < 2_000, "shutdown must escalate within the SIGKILL grace");
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
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

test("garbage stdout interleaved with ACP frames does not break a turn", async (t) => {
  const agent = makeAgent({ agent: { env: { GARBAGE_STDOUT: "1" } } });
  t.after(() => agent.close());
  const turn = await agent.prompt([{ type: "text", text: "hello" }]);
  assert.equal(turn.text, "[fast] hello");
  assert.equal(turn.stopReason, "end_turn");
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

test("a warm fork carries the same configured MCP declaration as a cold session", async (t) => {
  const mcpServers = [
    { name: "http-one", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" } },
    { name: "stdio-one", command: "/bin/true", env: { K: "v" } },
  ];
  const cold = makeAgent({ agent: { mcpServers } });
  const warm = makeAgent({ agent: { mcpServers, warmup: { prompt: "read the repository" } } });
  t.after(() => Promise.all([cold.close(), warm.close()]));

  const coldMcp = JSON.parse((await cold.prompt([{ type: "text", text: "ECHOMCP" }])).text);
  const forkMcp = JSON.parse((await warm.prompt([{ type: "text", text: "ECHOMCP" }])).text);
  assert.deepEqual(forkMcp, coldMcp);
  assert.equal(forkMcp.length, 2);
});

test("the first conversation after a child crash rebuilds and forks a warm base", async (t) => {
  const dir = await temporary(t);
  const pidFile = join(dir, "pid");
  const captureFile = join(dir, "warm-capture");
  let childExited;
  const exited = new Promise((resolve) => { childExited = resolve; });
  const agent = makeAgent({
    agent: {
      env: { PID_FILE: pidFile, WARM_CAPTURE_FILE: captureFile },
      warmup: { prompt: "WARMCOUNT read the repository" },
    },
    log: (_level, line) => {
      if (/agent exited/.test(line)) childExited();
    },
  });
  t.after(() => agent.close());

  assert.equal((await agent.prompt([{ type: "text", text: "ECHOSESSION" }])).text, "s2");
  const firstPid = Number(await readFile(pidFile, "utf8"));
  process.kill(firstPid, "SIGKILL");
  await exited;

  assert.equal((await agent.prompt([{ type: "text", text: "ECHOSESSION" }])).text, "s2");
  const secondPid = Number(await readFile(pidFile, "utf8"));
  assert.notEqual(secondPid, firstPid);
  assert.deepEqual((await readFile(captureFile, "utf8")).trim().split("\n"), ["warm", "fork", "warm", "fork"]);
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

test("by default the agent's running commentary is part of the answer", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.close());
  const turn = await agent.prompt([{ type: "text", text: "NARRATE" }]);
  // Every sentence it said along the way, glued to the one that answers -- which
  // is what a caller quotes and stores. Unpleasant, and the historical behaviour.
  assert.equal(turn.text, "Checking both hosts.Not in the docker group; using sudo.Nothing is restarting.");
});

test("commentary: trace moves what was said between tool calls into the trace", async (t) => {
  const agent = makeAgent({ server: { commentary: "trace", progress: "reasoning" } });
  t.after(() => agent.close());
  const events = [];
  const turn = await agent.prompt([{ type: "text", text: "NARRATE" }], { onEvent: (e) => events.push(e) });

  // The answer is the run nothing followed: the conclusion, on its own.
  assert.equal(turn.text, "Nothing is restarting.");
  // And the two sentences a tool call proved were commentary are in the reasoning
  // channel, where they are useful WHILE the turn is still running.
  assert.match(turn.reasoning, /Checking both hosts\./);
  assert.match(turn.reasoning, /Not in the docker group; using sudo\./);
  assert.doesNotMatch(turn.text, /docker group/);

  // Commentary reaches a streaming caller as it happens, not at the end.
  const said = events.findIndex((e) => e.type === "reasoning" && /docker group/.test(e.delta));
  const answered = events.findIndex((e) => e.type === "text");
  assert.ok(said >= 0 && said < answered, "commentary must be emitted before the answer");
  // Exactly one text event: the answer cannot be streamed before it is known to be
  // the answer, so it arrives whole.
  assert.equal(events.filter((e) => e.type === "text").length, 1);
});

test("commentary: trace leaves a turn that never used a tool alone", async (t) => {
  // Nothing followed the text, so nothing proved it was commentary. It IS the
  // answer, and moving it would leave the caller with an empty message.
  const agent = makeAgent({ server: { commentary: "trace" } });
  t.after(() => agent.close());
  const turn = await agent.prompt([{ type: "text", text: "hello" }]);
  assert.equal(turn.text, "[fast] hello");
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
