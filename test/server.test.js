import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, AgentError } from "../src/agent.js";
import { normalizeConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "fake-agent.js");

/** Starts the server on an ephemeral port and returns a fetch bound to it. */
async function start(t, { agents, specs, server: serverOpts } = {}) {
  const config = normalizeConfig(
    {
      server: { host: "127.0.0.1", port: 10021, cwd: here, ...serverOpts },
      agents: specs ?? [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }],
    },
    { baseDir: here, env: {} },
  );
  // The server's own log, kept so a test can wait for something to HAPPEN instead
  // of waiting for a duration. See `call.until`.
  const lines = [];
  const listeners = new Set();
  const log = (_level, line) => {
    lines.push(line);
    for (const l of [...listeners]) l(line);
  };
  const registry = agents ?? new Map(config.agents.map((s) => [s.name, new Agent(s, config.server, log)]));
  const server = createServer(config, { agents: registry, log });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    // Connections are DESTROYED, not waited for. A test that fails mid-request
    // leaves that request in flight, and `server.close()` waits for it: the file
    // then never exits, and neither does the job running it. Measured on CI --
    // one failed assertion, twelve minutes of a runner doing nothing, and a log
    // that simply stopped after the previous test file with no error anywhere.
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  /**
   * Resolves once the server has logged something matching `re`.
   *
   * This exists because "sleep and hope the turn started by now" is not a test, it
   * is a coin toss weighted by whatever machine it runs on. It passed on a laptop
   * with ten cores and failed on a two-core CI runner, where spawning the agent
   * takes longer than the wait -- so the second request found no turn to join,
   * started its own, and asserted against an answer that was never supposed to
   * exist.
   *
   * `new session for …` is logged immediately before `setBusy(convId, true)`, with
   * no await between them, so a request sent after this line is guaranteed to find
   * the conversation busy.
   */
  call.until = (re) =>
    new Promise((resolve, reject) => {
      if (lines.some((l) => re.test(l))) return resolve();
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`nothing matched ${re} in the server log:\n  ${lines.join("\n  ")}`));
      }, 10_000);
      const listener = (line) => {
        if (!re.test(line)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });

  return call;
}

const chat = (body) => ({ method: "POST", body: JSON.stringify(body) });

test("/health needs no key and lists the configured models", async (t) => {
  const call = await start(t);
  const res = await call("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", agents: ["fake"] });
});

test("/v1/models lists agents as OpenAI models", async (t) => {
  const call = await start(t);
  const body = await (await call("/v1/models")).json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data, [{ id: "fake", object: "model", created: 0, owned_by: "general" }]);
});

test("a non-streaming completion returns content, reasoning and usage", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "hello" }] }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "fake");
  assert.equal(body.choices[0].message.content, "[fast] hello");
  assert.equal(body.choices[0].message.reasoning_content, "thinking(low)");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 33);
});

test("a streaming completion emits SSE deltas and terminates with [DONE]", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "hello" }], stream: true }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);

  const raw = await res.text();
  const frames = raw.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));
  assert.equal(frames.at(-1), "[DONE]");

  const parsed = frames.slice(0, -1).map((f) => JSON.parse(f));
  assert.equal(parsed[0].choices[0].delta.role, "assistant");
  assert.equal(parsed.map((p) => p.choices[0].delta.content ?? "").join(""), "[fast] hello");
  assert.equal(parsed.map((p) => p.choices[0].delta.reasoning_content ?? "").join(""), "thinking(low)");
  assert.equal(parsed.at(-1).choices[0].finish_reason, "stop");
  assert.ok(parsed.slice(0, -1).every((p) => p.choices[0].finish_reason === null));
});

test("a quota failure is a real 429 even on a streaming request", async (t) => {
  const call = await start(t);
  for (const stream of [false, true]) {
    const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "QUOTA" }], stream }));
    // The whole point: headers are held back until the turn starts, so a router
    // sees 429 rather than a 200 that stops early.
    assert.equal(res.status, 429, `stream=${stream}`);
    assert.equal((await res.json()).error.code, "rate_limit_exceeded");
  }
});

test("an unrelated agent failure is 502", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "BOOM" }] }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "agent_error");
});

test("temperature is accepted, reported back, and does not fail the request", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "hi" }], temperature: 0, top_p: 0.9 }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "[fast] hi");
  // Accepted, but the caller is told rather than left believing it took effect.
  assert.deepEqual(body.x_acp2api, { ignored: ["temperature", "top_p"] });
});

test("with server.tools off, a tool-sending framework is still answered", async (t) => {
  // The shape a framework like Hermes sends on EVERY request: its whole toolset
  // plus sampling knobs. Refusing left such a client with no usable model at all,
  // so they are dropped and reported rather than rejected -- which is what this
  // server did for every version before tools were served.
  const call = await start(t, { server: { tools: "off" } });
  const res = await call(
    "/v1/chat/completions",
    chat({
      model: "fake",
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
      tool_choice: "auto",
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "[fast] hi");
  assert.deepEqual(body.x_acp2api.ignored, ["temperature", "tool_choice", "tools"]);
});

test("a growing history continues one session and sends only what is new", async (t) => {
  const call = await start(t);
  const ask = (messages) => call("/v1/chat/completions", chat({ model: "fake", messages }));
  const said = async (res) => (await res.json()).choices[0].message.content;

  // The fixture echoes both its session id and the prompt it was handed, so this
  // asserts what the agent actually saw rather than what we hoped it saw.
  const first = await said(await ask([{ role: "user", content: "ECHOSESSION one" }]));
  assert.match(first, /^s1/);

  const second = await said(
    await ask([
      { role: "user", content: "ECHOSESSION one" },
      { role: "assistant", content: first },
      { role: "user", content: "ECHOSESSION two" },
    ]),
  );
  // Same session: the agent kept whatever state it had built up.
  assert.match(second, /^s1/);
});

test("continuity resends nothing the session has already heard", async (t) => {
  const call = await start(t);
  const ask = (messages) => call("/v1/chat/completions", chat({ model: "fake", messages }));
  const said = async (res) => (await res.json()).choices[0].message.content;

  const first = await said(await ask([{ role: "user", content: "one" }]));
  const seen = await said(
    await ask([
      { role: "user", content: "one" },
      { role: "assistant", content: first },
      { role: "user", content: "two" },
    ]),
  );
  // The fixture echoes the prompt text it received. Only the new turn is in it --
  // no "one", and no replay of the answer we ourselves produced.
  assert.match(seen, /two/);
  assert.ok(!seen.includes("one"), `expected only the new turn, got ${JSON.stringify(seen)}`);
});

test("a diverging history starts a fresh session rather than guessing", async (t) => {
  const call = await start(t);
  const ask = (messages) => call("/v1/chat/completions", chat({ model: "fake", messages }));
  const said = async (res) => (await res.json()).choices[0].message.content;

  await ask([{ role: "user", content: "ECHOSESSION one" }]);
  // Same length, different content: this is a different conversation, not a
  // continuation, and reusing the session would put the agent in someone else's.
  const other = await said(await ask([{ role: "user", content: "ECHOSESSION elsewhere" }]));
  assert.match(other, /^s2/);
});

test("a changed system prompt is a different brief, not a continuation", async (t) => {
  const call = await start(t);
  const ask = (messages) => call("/v1/chat/completions", chat({ model: "fake", messages }));
  const said = async (res) => (await res.json()).choices[0].message.content;

  const sys = (text) => ({ role: "system", content: text });
  const first = await said(await ask([sys("be terse"), { role: "user", content: "ECHOSESSION one" }]));
  assert.match(first, /^s1/);

  const history = [
    { role: "user", content: "ECHOSESSION one" },
    { role: "assistant", content: first },
    { role: "user", content: "ECHOSESSION two" },
  ];
  assert.match(await said(await ask([sys("be terse"), ...history])), /^s1/);
  // Same conversation, different standing brief. Continuing under the old one would
  // let the agent go on following instructions it is no longer given.
  assert.match(await said(await ask([sys("be verbose"), ...history])), /^s2/);
});

test("a named conversation continues where prefix matching cannot", async (t) => {
  const call = await start(t);
  // The shape a framework like Hermes sends: it keeps the transcript on its own
  // side and hands over ONE rolled-up turn per request. Nothing about message two
  // extends message one, so `matchPrefix` has nothing to find -- which is exactly
  // the case a caller-supplied key exists for.
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-a")), /^s1/);
  assert.match(await said(await ask("ECHOSESSION two", "thread-a")), /^s1/);
});

test("busy: queue delivers a second message INTO the running turn", async (t) => {
  const call = await start(t, { server: { busy: "queue" } });
  const ask = (content) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": "thread-a" },
    });

  // Deliberately NOT awaited: the point is that the second request arrives while
  // the first turn is still running, which is the only moment an injection means
  // anything. Waiting for the LOG rather than for a duration -- the agent takes
  // however long it takes to spawn, and on a two-core runner that is longer than
  // any sleep worth writing.
  const running = ask("SLOWTURN please");
  await call.until(/new session for/);
  const injected = await (await ask("ALSO-THIS")).json();

  // The injection is answered immediately and empty. The answer is not its own:
  // it belongs to the turn it joined.
  assert.equal(injected.choices[0].message.content, "");

  // And that turn's caller receives both instructions, in one answer, having
  // waited only for the work -- not for a second round trip.
  const answer = (await (await running).json()).choices[0].message.content;
  assert.match(answer, /SLOWTURN please/);
  assert.match(answer, /ALSO-THIS/);
});

test("an injection that finds no running turn is refused, never run", async (t) => {
  // The caller has to guess which model a thread is on, so a miss must be free.
  // Falling through to the ordinary path would spend a turn of a real
  // subscription on work nobody is waiting for.
  const call = await start(t, { server: { busy: "queue" } });
  const res = await call("/v1/chat/completions", {
    ...chat({ model: "fake", messages: [{ role: "user", content: "ALSO-THIS" }] }),
    headers: { "x-conversation-id": "thread-nobody-is-in", "x-acp2api-inject": "1" },
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "no_running_turn");
});

test("a steering outcome that is not `injected` reaches the caller as a refusal", async (t) => {
  // `startedNewTurn` is the dangerous one: the turn ended underneath the steer and
  // the agent began a WHOLE NEW one, unasked, streaming to nobody. Counting that as
  // success would tell an injecting caller it had joined a turn it had in fact
  // created -- so it is reported as "did not join", and logged.
  const call = await start(t, {
    server: { busy: "queue" },
    specs: [
      {
        name: "fake",
        type: "general",
        command: process.execPath,
        args: [FIXTURE],
        env: { STEER_OUTCOME: "startedNewTurn" },
      },
    ],
  });
  const ask = (content) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": "thread-a", "x-acp2api-inject": "1" },
    });

  const running = call("/v1/chat/completions", {
    ...chat({ model: "fake", messages: [{ role: "user", content: "SLOWTURN please" }] }),
    headers: { "x-conversation-id": "thread-a" },
  });
  await call.until(/new session for/);
  assert.equal((await ask("ALSO-THIS")).status, 409);

  const answer = (await (await running).json()).choices[0].message.content;
  assert.match(answer, /SLOWTURN please/);
  assert.ok(!answer.includes("ALSO-THIS"));
});

test("an agent that never claimed it can steer is never sent a steering request", async (t) => {
  // ACP defines no mid-turn input at all, so this rests entirely on an extension
  // the agent has to advertise. Guessing was measured the hard way: a second
  // `session/prompt` into a session already prompting DEADLOCKS codex -- the first
  // request never resolves and the caller waits out its entire timeout, losing the
  // turn's work. The capability was in the handshake the whole time.
  const call = await start(t, {
    server: { busy: "queue" },
    specs: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE], env: { NOSTEER: "1" } }],
  });
  const ask = (content) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": "thread-a", "x-acp2api-inject": "1" },
    });

  const running = call("/v1/chat/completions", {
    ...chat({ model: "fake", messages: [{ role: "user", content: "SLOWTURN please" }] }),
    headers: { "x-conversation-id": "thread-a" },
  });
  await call.until(/new session for/);
  assert.equal((await ask("ALSO-THIS")).status, 409);

  // And the turn it refused to join finishes normally, on its own.
  const answer = (await (await running).json()).choices[0].message.content;
  assert.match(answer, /SLOWTURN please/);
  assert.ok(!answer.includes("ALSO-THIS"));
});

test("busy: fork keeps two concurrent turns apart, which is still the default", async (t) => {
  const call = await start(t);
  const ask = (content) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": "thread-a" },
    });

  const running = ask("SLOWTURN please");
  await call.until(/new session for/);
  const second = await (await ask("SEPARATE")).json();

  // A session of its own, so it answers for itself rather than joining anything.
  assert.match(second.choices[0].message.content, /SEPARATE/);
  assert.ok(!second.choices[0].message.content.includes("SLOWTURN"));
  const answer = (await (await running).json()).choices[0].message.content;
  assert.ok(!answer.includes("SEPARATE"), `the running turn must not have heard it, got ${answer}`);
});

test("a prompt is never queued into a session with no turn running", async (t) => {
  // It would run, cost a real turn of a real subscription, and stream its updates
  // to nobody. `inject` reports the refusal rather than doing it quietly.
  const agent = new Agent(
    normalizeConfig(
      { server: { cwd: here }, agents: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }] },
      { baseDir: here, env: {} },
    ).agents[0],
    normalizeConfig({ server: { cwd: here }, agents: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }] }, { baseDir: here, env: {} }).server,
  );
  t.after(() => agent.close());
  const session = await agent.openSession();
  assert.equal(await agent.inject(session, [{ type: "text", text: "hello" }]), false);
});

test("a named conversation replays nothing it has already heard", async (t) => {
  const call = await start(t);
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  await ask("one", "thread-a");
  const seen = await said(await ask("two", "thread-a"));
  assert.match(seen, /two/);
  assert.ok(!seen.includes("one"), `expected only the new turn, got ${JSON.stringify(seen)}`);
});

test("a continued conversation bills each turn, not the session so far", async (t) => {
  const call = await start(t);
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const usageOf = async (res) => (await res.json()).usage;

  // The fixture charges an identical 11/22/3 per turn and reports the running
  // SESSION total, the way a real ACP agent does. Passed through unchanged, turn
  // two would claim to have cost twice what turn one did.
  const first = await usageOf(await ask("one", "thread-a"));
  const second = await usageOf(await ask("two", "thread-a"));

  assert.equal(first.prompt_tokens, 11);
  assert.equal(first.completion_tokens, 22);
  assert.equal(second.prompt_tokens, 11, "turn two must not re-bill turn one's input");
  assert.equal(second.completion_tokens, 22);
  assert.equal(second.total_tokens, 33);
});

test("cache reads reach the caller, because they are the only proof continuity paid off", async (t) => {
  const call = await start(t);
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const usageOf = async (res) => (await res.json()).usage;

  const first = await usageOf(await ask("one", "thread-b"));
  const second = await usageOf(await ask("two", "thread-b"));

  // The first turn writes the cache and reads nothing; the second reads it.
  assert.equal(first.prompt_tokens_details.cached_tokens, 0);
  assert.equal(first.prompt_tokens_details.cache_creation_tokens, 11);
  assert.equal(second.prompt_tokens_details.cached_tokens, 10);
  assert.equal(second.prompt_tokens_details.cache_creation_tokens, 0);
});

test("a fresh conversation is billed in full, with no baseline to subtract", async (t) => {
  const call = await start(t);
  const one = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "hi" }] }));
  const two = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "hi" }] }));
  // Two unrelated requests, two sessions: each pays its own first turn in full,
  // and neither may come out as zero because the other had already reported.
  assert.equal((await one.json()).usage.prompt_tokens, 11);
  assert.equal((await two.json()).usage.prompt_tokens, 11);
});

test("different keys are different conversations", async (t) => {
  const call = await start(t);
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-a")), /^s1/);
  // Same text, different thread. Joining them would put one channel's agent into
  // another channel's conversation.
  assert.match(await said(await ask("ECHOSESSION one", "thread-b")), /^s2/);
});

test("a key outranks a changed system prompt", async (t) => {
  const call = await start(t);
  const ask = (sys, content, key) =>
    call("/v1/chat/completions", {
      ...chat({
        model: "fake",
        messages: [
          { role: "system", content: sys },
          { role: "user", content },
        ],
      }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("be terse", "ECHOSESSION one", "thread-a")), /^s1/);
  // Under prefix matching a changed preamble MUST fork -- it is the only evidence
  // of identity available. A key is better evidence, and a real caller rewrites
  // its preamble constantly: injected memory, a profile, the date the thread
  // started. Forking on that would mean never continuing anything.
  assert.match(await said(await ask("be verbose", "ECHOSESSION two", "thread-a")), /^s1/);
});

test('conversationHeader: "" turns naming off', async (t) => {
  const call = await start(t, { server: { conversationHeader: "" } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-a")), /^s1/);
  // The header is now just a header, and prefix matching cannot save this shape.
  assert.match(await said(await ask("ECHOSESSION two", "thread-a")), /^s2/);
});

test("continuity: false restores a fresh session per request", async (t) => {
  const call = await start(t, { server: { continuity: false } });
  const ask = (messages) => call("/v1/chat/completions", chat({ model: "fake", messages }));
  const said = async (res) => (await res.json()).choices[0].message.content;

  const first = await said(await ask([{ role: "user", content: "ECHOSESSION one" }]));
  const second = await said(
    await ask([
      { role: "user", content: "ECHOSESSION one" },
      { role: "assistant", content: first },
      { role: "user", content: "ECHOSESSION two" },
    ]),
  );
  assert.match(first, /^s1/);
  assert.match(second, /^s2/);
});

test("a failed turn does not leave its session to be continued", async (t) => {
  const call = await start(t);
  const ask = (messages) => call("/v1/chat/completions", chat({ model: "fake", messages }));

  assert.equal((await ask([{ role: "user", content: "BOOM" }])).status, 502);
  // A session that never answered has heard messages nobody can account for.
  const after = await (await ask([{ role: "user", content: "ECHOSESSION next" }])).json();
  assert.match(after.choices[0].message.content, /^s2/);
});

test("response_format is still a 400", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "unsupported_parameter");
});

test("a history with tool calls and results reaches the agent intact", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({
      model: "fake",
      messages: [
        { role: "user", content: "fix it" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "recall", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "you prefer tabs" },
      ],
    }),
  );
  // The fixture echoes the prompt it received, so this asserts what the agent saw.
  const seen = (await res.json()).choices[0].message.content;
  assert.match(seen, /\[calls recall\]/);
  assert.match(seen, /\[result of recall\]\nyou prefer tabs/);
  assert.ok(!seen.includes("User: you prefer tabs"));
});

test("unsupportedParams: error turns the ignorable ones into 400 too", async (t) => {
  const call = await start(t, { server: { unsupportedParams: "error" } });
  const ok = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(ok.status, 200);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "hi" }], temperature: 0 }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "unsupported_parameter");
});

test("max_tokens truncates and finishes with length", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "COUNT" }], max_tokens: 3 }),
  );
  const body = await res.json();
  assert.equal(body.choices[0].finish_reason, "length");
  assert.ok(body.choices[0].message.content.length <= 12);
});

test("stop cuts the answer and finishes with stop", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "COUNT" }], stop: "word4" }),
  );
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "word1 word2 word3 ");
  assert.equal(body.choices[0].finish_reason, "stop");
});

test("stream_options.include_usage appends a usage-only chunk before [DONE]", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({
      model: "fake",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  );
  const frames = (await res.text()).split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));
  assert.equal(frames.at(-1), "[DONE]");
  const last = JSON.parse(frames.at(-2));
  assert.deepEqual(last.choices, []);
  assert.equal(last.usage.total_tokens, 33);
});

test("an unknown model is 404 and names what is available", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", chat({ model: "nope", messages: [{ role: "user", content: "x" }] }));
  assert.equal(res.status, 404);
  const { error } = await res.json();
  assert.equal(error.code, "model_not_found");
  assert.match(error.message, /available: fake/);
});

test("bad requests are 400 with an OpenAI-shaped error", async (t) => {
  const call = await start(t);
  assert.equal((await call("/v1/chat/completions", { method: "POST", body: "{oops" })).status, 400);
  assert.equal((await call("/v1/chat/completions", chat({ messages: [] }))).status, 400);
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [] }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, "invalid_request_error");
  assert.equal((await call("/nope")).status, 404);
});

test("the request timeout is a 504, not a truncated 200", async (t) => {
  const specs = [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }];
  const config = normalizeConfig(
    { server: { host: "127.0.0.1", cwd: here, requestTimeoutMs: 300 }, agents: specs },
    { baseDir: here, env: {} },
  );
  const agent = new Agent(config.agents[0], config.server);
  const server = createServer(config, { agents: new Map([["fake", agent]]) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    // Connections are DESTROYED, not waited for. A test that fails mid-request
    // leaves that request in flight, and `server.close()` waits for it: the file
    // then never exits, and neither does the job running it. Measured on CI --
    // one failed assertion, twelve minutes of a runner doing nothing, and a log
    // that simply stopped after the previous test file with no error anywhere.
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake", messages: [{ role: "user", content: "HANG" }] }),
  });
  // ACP reports a cancelled turn as an ordinary stop reason; if that leaked through
  // as 200 a router would count the empty answer as a success.
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, "timeout");
  t.after(() => agent.close());
});

test("closing the server shuts every agent down", async (t) => {
  let closed = 0;
  const fake = { name: "stub", spec: { type: "general" }, prompt: async () => ({ text: "", stopReason: "end_turn" }), close: () => closed++ };
  const call = await start(t, { agents: new Map([["stub", fake]]) });
  await call("/health");
  // start()'s t.after closes the server; assert on the next tick after that runs.
  t.after(() => assert.equal(closed, 1));
});

test("an agent error carrying no status still yields a 500-class response", async (t) => {
  const boom = {
    name: "stub",
    spec: { type: "general" },
    openSession: async () => ({ id: "s", options: [] }),
    closeSession: async () => {},
    turn: async () => {
      throw new AgentError("upstream said no", 502, "agent_error");
    },
    close: () => {},
  };
  const call = await start(t, { agents: new Map([["stub", boom]]) });
  const res = await call("/v1/chat/completions", chat({ model: "stub", messages: [{ role: "user", content: "x" }] }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.message, "upstream said no");
});

test("progress is off by default: activity never reaches the caller", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "WORK" }] }));
  const msg = (await res.json()).choices[0].message;
  assert.equal(msg.content, "done");
  assert.equal(msg.reasoning_content, "thinking(low)");
});

test("progress narrates tool calls, diffs and the plan into reasoning", async (t) => {
  const call = await start(t, { server: { progress: "reasoning" } });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "WORK" }] }));
  const msg = (await res.json()).choices[0].message;

  // The answer is untouched: a trace written into the text becomes the answer.
  assert.equal(msg.content, "done");

  const notes = msg.reasoning_content;
  assert.match(notes, /thinking\(low\)/, "the agent's own thinking still comes through");
  assert.match(notes, /▸ plan 1\/3 — patch the compose file/);
  assert.match(notes, /› Edit compose\.yaml/);
  assert.match(notes, /± compose\.yaml \+2\/-1/);
  assert.match(notes, /✗ Bash pytest/);
  // Started once, not once per update.
  assert.equal(notes.match(/› Edit compose\.yaml/g).length, 1);
});

test("progress streams as it happens, not as a summary at the end", async (t) => {
  const call = await start(t, { server: { progress: "reasoning" } });
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "WORK" }], stream: true }),
  );
  const body = await res.text();
  const deltas = body
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)).choices[0].delta);

  const reasoning = deltas.map((d) => d.reasoning_content ?? "");
  assert.ok(reasoning.join("").includes("› Edit compose.yaml"), "notes arrive as reasoning deltas");

  // The point of streaming progress is that it is live. A note about the last tool
  // must be on the wire before the first character of the answer, not batched after.
  const lastNote = reasoning.findLastIndex((r) => r.includes("Bash pytest"));
  const firstAnswer = deltas.findIndex((d) => d.content);
  assert.ok(lastNote >= 0 && firstAnswer >= 0, "expected both a note and an answer");
  assert.ok(lastNote < firstAnswer, `note at ${lastNote} should precede answer at ${firstAnswer}`);
});

test("a named session outlives a turn nobody waited for", async (t) => {
  // This is steering on the wire: a turn is abandoned mid-flight and the next
  // message is the correction. If the session went with the abandoned turn, the
  // correction would reach an agent that had forgotten everything it had read --
  // which is exactly the work the human was trying not to waste.
  const call = await start(t, { server: { requestTimeoutMs: 400 } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-y")), /^s1/);

  const abandoned = await ask("HANG", "thread-y");
  assert.equal(abandoned.status, 504);
  await abandoned.json();

  assert.match(
    await said(await ask("ECHOSESSION two", "thread-y")),
    /^s1/,
    "the correction must land in the session that did the work",
  );
});

test("a named session does NOT outlive a turn the agent itself failed", async (t) => {
  // A broken agent is not a redirected one. Keeping the session here would offer
  // the next request a conversation whose state nobody can account for.
  const call = await start(t);
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-z")), /^s1/);
  assert.equal((await ask("BOOM", "thread-z")).status, 502);
  assert.match(await said(await ask("ECHOSESSION two", "thread-z")), /^s2/);
});

test("a session that has filled its context window is retired, not reused", async (t) => {
  // A TTL bounds idleness and says nothing about size. The conversation continuity
  // works hardest to keep is the one that grows into the agent's own compaction and
  // then into a context it cannot recover from -- so fullness has to end a session
  // even when someone is still actively using it.
  const call = await start(t, { server: { maxContextFill: 0.8 } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("FILL", "thread-f")), /^s1/);
  assert.match(
    await said(await ask("ECHOSESSION next", "thread-f")),
    /^s2/,
    "a 95%-full session must not be handed the next turn",
  );
});

test("retirement is off when no ceiling is configured", async (t) => {
  const call = await start(t, { server: { maxContextFill: 0 } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("FILL", "thread-g")), /^s1/);
  assert.match(await said(await ask("ECHOSESSION next", "thread-g")), /^s1/);
});

test("an agent that never reports usage keeps its sessions", async (t) => {
  // Silence is not evidence of room. Guessing would retire healthy sessions on
  // every agent that does not implement usage_update.
  const call = await start(t, { server: { maxContextFill: 0.1 } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-h")), /^s1/);
  assert.match(await said(await ask("ECHOSESSION two", "thread-h")), /^s1/);
});

test("a thread that went quiet resumes its session instead of starting cold", async (t) => {
  // The point of parking: an idle conversation gives back the expensive half -- the
  // resident session and the login it holds -- and keeps the id. Coming back must
  // land in the SAME agent session, still holding whatever it had read.
  const call = await start(t, { server: { sessionTtlMs: 1 } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  assert.match(await said(await ask("ECHOSESSION one", "thread-p")), /^s1/);
  // A TTL of 1ms means the next request's prune parks it first.
  await new Promise((r) => setTimeout(r, 20));
  assert.match(
    await said(await ask("ECHOSESSION two", "thread-p")),
    /^s1/,
    "a parked thread must come back to its own session, not a new one",
  );
});

test("a session the agent cannot resume becomes a fresh one, not an error", async (t) => {
  // Resume is best effort. An id the agent has lost means this conversation is
  // cold now -- which is a cold answer, not a failed request.
  const call = await start(t, { server: { sessionTtlMs: 1 } });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const said = async (res) => (await res.json()).choices[0].message.content;

  // AMNESIA makes the agent forget its own session, the way a real one does once
  // its stored transcript is gone.
  assert.match(await said(await ask("AMNESIA", "thread-q")), /^s1/);
  // The body can reach the client a tick before the request's own cleanup marks
  // the conversation idle, and `prune` skips a busy one on purpose.
  await new Promise((r) => setTimeout(r, 30));
  // An unrelated thread opens a session, and the prune that precedes it parks the
  // first -- parking is what puts thread-q on the resume path at all.
  await ask("ECHOSESSION other", "thread-r");

  const res = await ask("ECHOSESSION two", "thread-q");
  assert.equal(res.status, 200, "a lost session is answered, not turned into a 502");
  assert.doesNotMatch(await said(res), /^s1/, "and answered from a session that exists");
});

test("with the terminal capability on, the agent's commands run here", async (t) => {
  const call = await start(t, { server: { terminal: true } });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "SHELL" }] }));
  const seen = JSON.parse((await res.json()).choices[0].message.content);
  assert.equal(seen.exit.exitCode, 0);
  assert.equal(seen.truncated, false);
  assert.match(seen.output, /out-/, "stdout reaches the agent");
  assert.match(seen.output, /err/, "and stderr does too, in the same stream");
  assert.ok(seen.exitStatus, "output reports the exit status once the command has finished");
});

test("a command asking to run outside the workspace is refused, not run", async (t) => {
  const call = await start(t, { server: { terminal: true } });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "ESCAPE" }] }));
  const said = (await res.json()).choices[0].message.content;
  assert.match(said, /^REFUSED:.*outside workspace/);
});

test("one command can be stopped without ending the turn", async (t) => {
  // The reason the capability is worth owning: session/cancel is the only other
  // stop, and it takes the whole turn -- plan, open files and all -- with it.
  const call = await start(t, { server: { terminal: true } });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "KILLIT" }] }));
  assert.equal(res.status, 200, "the turn survives the command it killed");
  const exit = JSON.parse((await res.json()).choices[0].message.content);
  assert.ok(exit.signal || exit.exitCode !== 0, `expected a killed process, got ${JSON.stringify(exit)}`);
});

test("without the capability the agent is never offered a terminal", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "SHELL" }] }));
  // The fixture asks anyway; an unadvertised capability must answer "no such
  // method" rather than quietly running the command.
  assert.match((await res.json()).choices[0].message.content, /^REFUSED:/);
});

test("the session mode is selected by category, like model and reasoning", async (t) => {
  // The autonomy control: set once for the session rather than answered per action.
  // The fixture's option is called `permission-mode`, so an implementation that
  // matched on the id would miss it -- exactly the way claude and codex differ.
  const call = await start(t, {
    specs: [
      {
        name: "fake",
        type: "general",
        command: process.execPath,
        args: [FIXTURE],
        mode: "acceptEdits",
      },
    ],
  });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "ECHOMODE" }] }));
  assert.equal((await res.json()).choices[0].message.content, "acceptEdits");
});

test("a mode the agent does not offer fails loudly rather than running anyway", async (t) => {
  const call = await start(t, {
    specs: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE], mode: "yolo" }],
  });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /no value "yolo"/);
});

test("a warmed base is read once and forked by every conversation after it", async (t) => {
  // The point of warming: a cold session re-orients before it can do anything --
  // reads the instructions, lists the tree, greps for its bearings -- and every new
  // conversation pays for that again. Warming once and forking pays it once.
  const call = await start(t, {
    specs: [
      {
        name: "fake",
        type: "general",
        command: process.execPath,
        args: [FIXTURE],
        warmup: { prompt: "read the repository" },
      },
    ],
  });
  const ask = (content, key) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages: [{ role: "user", content }] }),
      headers: { "x-conversation-id": key },
    });
  const seen = async (res) => JSON.parse((await res.json()).choices[0].message.content);

  const first = await seen(await ask("ECHOHEARD one", "thread-w1"));
  const second = await seen(await ask("ECHOHEARD two", "thread-w2"));

  // Both threads are forks of the same base, and both start knowing what it read.
  assert.equal(first.from, "s1", "the base is the session that was warmed");
  assert.equal(second.from, "s1", "and it is reused rather than warmed again");
  assert.notEqual(first.id, second.id, "each conversation still gets its own session");
  assert.match(first.heard[0], /read the repository/, "the fork inherits the warm-up");
  assert.match(second.heard[0], /read the repository/);
  // And the warm-up is not repeated per conversation -- that is the whole saving.
  assert.equal(second.heard.filter((h) => h.includes("read the repository")).length, 1);
});

test("a warm-up that fails leaves sessions cold rather than failing the request", async (t) => {
  // Starting cold is slower and more expensive. It is never wrong, so it is what
  // every failure on the warm path falls back to.
  const call = await start(t, {
    specs: [
      {
        name: "fake",
        type: "general",
        command: process.execPath,
        args: [FIXTURE],
        warmup: { prompt: "BOOM" },
      },
    ],
  });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200, "the caller gets an answer, not the warm-up's failure");
  assert.equal((await res.json()).choices[0].message.content, "[fast] hi");
});

test("with no warmup configured nothing is forked", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "ECHOHEARD" }] }));
  const seen = JSON.parse((await res.json()).choices[0].message.content);
  assert.equal(seen.from, null);
  assert.equal(seen.heard.length, 1, "only the caller's own turn");
});

test("a shell command's output reaches the caller in the trace", async (t) => {
  const call = await start(t, { server: { progress: "reasoning", progressOutputLines: 2 } });
  const res = await call("/v1/chat/completions", chat({ model: "fake", messages: [{ role: "user", content: "RUNCMD" }] }));
  const msg = (await res.json()).choices[0].message;

  assert.equal(msg.content, "ran", "the answer stays the answer");
  const trace = msg.reasoning_content;
  // Named by the command, never by the "Terminal" placeholder it opens with.
  assert.doesNotMatch(trace, /Terminal/);
  assert.match(trace, /› make check/);
  assert.match(trace, /⎿ all good/);
  assert.match(trace, /✗ make check \(exit 2\)/);
  // The fenced-console fallback reads the same way.
  assert.match(trace, /› npm test/);
  assert.match(trace, /⎿ 1 failed, 3 passed/);
  // Bounded: everything above the last two lines stays out.
  assert.doesNotMatch(trace, /buried-by-the-cap/);
});

// --- the caller's own tools, served to the agent as an MCP server ----------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file the client has access to",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

test("a caller's tools are offered to the agent, and a call comes back as tool_calls", async (t) => {
  // The whole contract in one turn: the tools reach the agent as an MCP server it
  // can list, and when it calls one the completion stops with `tool_calls` -- the
  // shape every OpenAI client already knows how to handle.
  const call = await start(t);
  const res = await call("/v1/chat/completions", {
    ...chat({
      model: "fake",
      messages: [{ role: "user", content: 'USETOOL read_file {"path":"README.md"}' }],
      tools: TOOLS,
    }),
    headers: { "x-conversation-id": "tools-a" },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  const [tc] = body.choices[0].message.tool_calls;
  assert.equal(tc.function.name, "read_file");
  assert.deepEqual(JSON.parse(tc.function.arguments), { path: "README.md" });
  // Whatever the agent said before calling is carried too -- a message may hold
  // both, and that sentence is usually the one explaining the call.
  assert.match(body.choices[0].message.content, /TOOLS:read_file/);
});

test("the result the caller sends back reaches the same turn, which then finishes", async (t) => {
  // This is what a suspended turn is FOR. No new session, no replayed history --
  // the agent is still inside the call it made, and gets its answer.
  const call = await start(t);
  const ask = (messages) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages, tools: TOOLS }),
      headers: { "x-conversation-id": "tools-b" },
    });

  const first = await (await ask([{ role: "user", content: 'USETOOL read_file {"path":"x"}' }])).json();
  const callId = first.choices[0].message.tool_calls[0].id;

  const second = await ask([
    { role: "user", content: 'USETOOL read_file {"path":"x"}' },
    first.choices[0].message,
    { role: "tool", tool_call_id: callId, content: "the file said hello" },
  ]);
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.choices[0].finish_reason, "stop");
  // The agent saw the caller's result, and said so.
  // Only this segment: what the agent said BEFORE the call went to the response
  // that carried the call, and repeating it here would deliver it twice.
  assert.equal(body.choices[0].message.content.trim(), "RESULT:the file said hello");
});

test("a tool result for a call nobody is waiting on is refused, not run as a new turn", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", {
    ...chat({
      model: "fake",
      messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "call_nope", content: "x" }],
      tools: TOOLS,
    }),
    headers: { "x-conversation-id": "tools-c" },
  });
  assert.equal(res.status, 200, "no turn was suspended, so this is an ordinary turn");
});

test("server.tools off keeps the old behaviour: no MCP server is attached", async (t) => {
  const call = await start(t, { server: { tools: "off" } });
  const res = await call("/v1/chat/completions", {
    ...chat({ model: "fake", messages: [{ role: "user", content: "USETOOL read_file" }], tools: TOOLS }),
    headers: { "x-conversation-id": "tools-d" },
  });
  const body = await res.json();
  assert.match(body.choices[0].message.content, /NO-TOOL-SERVER/);
});

test("the MCP endpoint answers the agent, which carries nothing but its token", async (t) => {
  // The token in the path is the only thing that addresses a conversation's tools.
  // This route once sat behind an api-key gate the agent was never given, which
  // made every connection a silent 401: the tools simply never appeared, with
  // nothing in the log to say why. The key is gone; the route is still checked.
  const call = await start(t);
  const res = await call("/mcp/no-such-token", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error.message, "unknown tool session");
});

test("tool_choice is reported as ignored even while the tools themselves are served", async (t) => {
  // Serving the tools and honouring `tool_choice` are different promises. The
  // agent decides what to call and when; there is no way to tell it "you must call
  // this one" through a tool server. Dropping the parameter quietly, next to tools
  // that DO work, is how a caller comes to believe `required` was honoured.
  const call = await start(t);
  const res = await call("/v1/chat/completions", {
    ...chat({
      model: "fake",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      tool_choice: "required",
    }),
    headers: { "x-conversation-id": "tools-e" },
  });
  const body = await res.json();
  assert.deepEqual(body.x_acp2api.ignored, ["tool_choice"]);
});

test("a streaming completion that stops for a tool emits the call and finishes cleanly", async (t) => {
  const call = await start(t);
  const res = await call("/v1/chat/completions", {
    ...chat({
      model: "fake",
      messages: [{ role: "user", content: 'USETOOL read_file {"path":"x"}' }],
      tools: TOOLS,
      stream: true,
    }),
    headers: { "x-conversation-id": "tools-stream" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);

  const frames = (await res.text()).split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));
  assert.equal(frames.at(-1), "[DONE]", "a stream that stops for a tool still terminates properly");
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
  const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "read_file");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("a streaming turn resumed from a tool result finishes as a normal stream", async (t) => {
  const call = await start(t);
  const ask = (messages) =>
    call("/v1/chat/completions", {
      ...chat({ model: "fake", messages, tools: TOOLS, stream: true }),
      headers: { "x-conversation-id": "tools-stream-2" },
    });
  const user = { role: "user", content: 'USETOOL read_file {"path":"x"}' };

  const opening = (await (await ask([user])).text())
    .split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""))
    .slice(0, -1).map((f) => JSON.parse(f));
  const id = opening.flatMap((c) => c.choices[0].delta.tool_calls ?? [])[0].id;

  const rest = (await (
    await ask([
      user,
      { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: "the file said hello" },
    ])
  ).text())
    .split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));

  assert.equal(rest.at(-1), "[DONE]");
  const chunks = rest.slice(0, -1).map((f) => JSON.parse(f));
  assert.match(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), /RESULT:the file said hello/);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("a tool-enabled turn streams its trace as it happens, not in one piece at the end", async (t) => {
  // The regression this pins: with tools present every turn took the tool path,
  // which collected the reasoning channel and delivered it with the answer. The
  // caller's progress bubble vanished from every conversation and nothing failed
  // to say so -- the answer arrived exactly as before.
  const call = await start(t);
  const res = await call("/v1/chat/completions", {
    ...chat({
      model: "fake",
      messages: [{ role: "user", content: "COUNT" }],
      tools: TOOLS,
      stream: true,
    }),
    headers: { "x-conversation-id": "tools-live" },
  });

  const frames = (await res.text()).split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""));
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
  // More than one frame carries content: the answer was streamed, not posted whole.
  const withContent = chunks.filter((c) => (c.choices[0].delta.content ?? "") !== "");
  assert.ok(withContent.length > 1, `expected the text to arrive in deltas, got ${withContent.length} frame(s)`);
  assert.ok(
    chunks.some((c) => (c.choices[0].delta.reasoning_content ?? "") !== ""),
    "the reasoning channel must reach the caller while the turn runs",
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});
