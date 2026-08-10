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
async function start(t, { apiKey = "", agents, specs, server: serverOpts } = {}) {
  const config = normalizeConfig(
    {
      server: { host: "127.0.0.1", port: 10021, apiKey, cwd: here, ...serverOpts },
      agents: specs ?? [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }],
    },
    { baseDir: here, env: {} },
  );
  const registry = agents ?? new Map(config.agents.map((s) => [s.name, new Agent(s, config.server)]));
  const server = createServer(config, { agents: registry });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(init.headers ?? {}),
      },
    });
}

const chat = (body) => ({ method: "POST", body: JSON.stringify(body) });

test("/health needs no key and lists the configured models", async (t) => {
  const call = await start(t, { apiKey: "secret" });
  const res = await call("/health", { headers: { authorization: "" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", agents: ["fake"] });
});

test("/v1/models lists agents as OpenAI models", async (t) => {
  const call = await start(t);
  const body = await (await call("/v1/models")).json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data, [{ id: "fake", object: "model", created: 0, owned_by: "general" }]);
});

test("the api key is enforced on everything but /health", async (t) => {
  const call = await start(t, { apiKey: "secret" });
  assert.equal((await call("/v1/models", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call("/v1/models", { headers: { authorization: "" } })).status, 401);
  // Length differences must not short-circuit into a different code path.
  assert.equal((await call("/v1/models", { headers: { authorization: "Bearer s" } })).status, 401);
  assert.equal((await call("/v1/models")).status, 200);
  // Anthropic-style clients send x-api-key instead of a bearer token.
  assert.equal((await call("/v1/models", { headers: { authorization: "", "x-api-key": "secret" } })).status, 200);
});

test("an empty apiKey disables authentication entirely", async (t) => {
  const call = await start(t);
  assert.equal((await call("/v1/models", { headers: { authorization: "" } })).status, 200);
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

test("tools is a 400 that says where tools actually come from", async (t) => {
  const call = await start(t);
  const res = await call(
    "/v1/chat/completions",
    chat({ model: "fake", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] }),
  );
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.code, "unsupported_parameter");
  assert.match(error.message, /mcpServers/);
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
  t.after(() => new Promise((r) => server.close(r)));

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
    prompt: async () => {
      throw new AgentError("upstream said no", 502, "agent_error");
    },
    close: () => {},
  };
  const call = await start(t, { agents: new Map([["stub", boom]]) });
  const res = await call("/v1/chat/completions", chat({ model: "stub", messages: [{ role: "user", content: "x" }] }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.message, "upstream said no");
});
