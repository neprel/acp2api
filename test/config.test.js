import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, expandEnv, loadConfig, normalizeConfig, resolvePreset } from "../src/config.js";

const minimal = { agents: [{ name: "a", type: "claude" }] };
const load = (raw, env) => normalizeConfig(raw, { baseDir: "/base", env: env ?? {} });

test("fills defaults and resolves cwd against the config file's directory", () => {
  const c = load({ ...minimal, server: { cwd: "work" } });
  assert.equal(c.server.host, "127.0.0.1");
  assert.equal(c.server.port, 10021);
  assert.equal(c.server.cwd, "/base/work");
  assert.equal(c.agents[0].cwd, "/base/work");
});

test("an absolute cwd is left alone", () => {
  assert.equal(load({ ...minimal, server: { cwd: "/srv/work" } }).server.cwd, "/srv/work");
});

test("a per-agent cwd resolves against the server workspace", () => {
  const c = load({ server: { cwd: "/w" }, agents: [{ name: "a", type: "claude", cwd: "repo" }] });
  assert.equal(c.agents[0].cwd, "/w/repo");
});

test("known types get their spawn command, general must supply one", () => {
  const c = load({ agents: [{ name: "c", type: "claude" }, { name: "x", type: "codex" }] });
  // Resolved to `node <the installed adapter's entry point>` rather than to a bare
  // bin name: a dependency's bin is not on PATH when this package is global.
  for (const [i, pkg] of [[0, "claude-agent-acp"], [1, "codex-acp"]]) {
    assert.equal(c.agents[i].command, process.execPath);
    assert.match(c.agents[i].args[0], new RegExp(`@agentclientprotocol/${pkg}/.*\\.js$`));
  }
  assert.throws(() => load({ agents: [{ name: "g", type: "general" }] }), /command is required/);
  const g = load({ agents: [{ name: "g", type: "general", command: "opencode", args: ["acp"] }] });
  assert.deepEqual([g.agents[0].command, g.agents[0].args], ["opencode", ["acp"]]);
});

test("an explicit command overrides the preset and skips resolution", () => {
  const c = load({ agents: [{ name: "c", type: "claude", command: "/opt/claude-acp" }] });
  assert.equal(c.agents[0].command, "/opt/claude-acp");
  assert.deepEqual(c.agents[0].args, []);
});

test("resolvePreset falls back to the bare bin name when the adapter is absent", () => {
  const missing = resolvePreset({ pkg: "@agentclientprotocol/not-installed", bin: "whatever-acp" });
  assert.deepEqual(missing, { command: "whatever-acp", args: [] });
});

test("agent names are the model ids, so duplicates are rejected", () => {
  assert.throws(() => load({ agents: [{ name: "a", type: "claude" }, { name: "a", type: "codex" }] }), /used more than once/);
});

test("unknown keys are rejected at every structured config level with a suggestion", () => {
  assert.throws(() => load({ ...minimal, agent: [] }), /config\.agent.*did you mean `agents`/);
  assert.throws(() => load({ ...minimal, server: { metricAddr: "off" } }), /server\.metricAddr.*`metricsAddr`/);
  assert.throws(() => load({ agents: [{ name: "a", type: "claude", modell: "fast" }] }), /agents\[0\]\.modell.*`model`/);
  assert.throws(
    () => load({ agents: [{ name: "a", type: "claude", warmup: { prompt: "read", ttl: 1 } }] }),
    /agents\[0\]\.warmup\.ttl.*`ttlMs`/,
  );
  assert.throws(
    () => load({ agents: [{ name: "a", type: "claude", mcpServers: [{ name: "m", comand: "x" }] }] }),
    /agents\[0\]\.mcpServers\[0\]\.comand.*`command`/,
  );
});

test("rejects malformed input rather than guessing", () => {
  assert.throws(() => load({ agents: [] }), /non-empty `agents`/);
  assert.throws(() => load({ ...minimal, server: { port: 0 } }), /port/);
  assert.throws(() => load({ ...minimal, server: { permission: "maybe" } }), /permission/);
  assert.throws(() => load({ agents: [{ name: "a", type: "nope" }] }), /type must be one of/);
  assert.throws(() => load({ agents: [{ type: "claude" }] }), /name is required/);
  assert.throws(() => load({ agents: [{ name: "a", type: "claude", args: "acp" }] }), /args must be a list/);
});

test("metricsAddr is parsed once, including bracketed IPv6, and validates its port", () => {
  assert.deepEqual(load({ ...minimal, server: { metricsAddr: "127.0.0.1:9090" } }).server.metricsAddr,
    { host: "127.0.0.1", port: 9090 });
  assert.deepEqual(load({ ...minimal, server: { metricsAddr: "[::1]:9090" } }).server.metricsAddr,
    { host: "::1", port: 9090 });
  assert.throws(() => load({ ...minimal, server: { metricsAddr: "::1:9090" } }), /metricsAddr/);
  assert.throws(
    () => load({ ...minimal, server: { metricsAddr: "localhost:99999" } }),
    /metricsAddr.*got localhost:99999/,
  );
});

test("CORS is off by default and accepts an origin or an explicit wildcard", () => {
  assert.equal(load(minimal).server.cors, false);
  assert.equal(load({ ...minimal, server: { cors: "https://app.example" } }).server.cors, "https://app.example");
  assert.equal(load({ ...minimal, server: { cors: "true" } }).server.cors, true);
  assert.throws(() => load({ ...minimal, server: { cors: "" } }), /server\.cors/);
  assert.throws(() => load({ ...minimal, server: { cors: 1 } }), /server\.cors/);
});

test("${VAR} expands, ${VAR:-default} falls back, an unset bare VAR is fatal", () => {
  assert.equal(expandEnv("a-${X}-b", { X: "1" }), "a-1-b");
  assert.equal(expandEnv("${MISSING:-fallback}", {}), "fallback");
  assert.equal(expandEnv("${EMPTY:-fallback}", { EMPTY: "" }), "fallback");
  assert.deepEqual(expandEnv({ k: ["${X}"] }, { X: "v" }), { k: ["v"] });
  // Silently starting with an empty api key would leave the port unauthenticated.
  assert.throws(() => expandEnv("${NOPE}", {}), ConfigError);
});

test("env expansion preserves bare empty values and supports literal placeholders", () => {
  assert.equal(expandEnv("${EMPTY}", { EMPTY: "" }), "");
  assert.equal(expandEnv("${EMPTY:-fallback}", { EMPTY: "" }), "fallback");
  assert.equal(expandEnv("keep $${NOT_EXPANDED} here", {}), "keep ${NOT_EXPANDED} here");
});

test("numbers that arrive as strings from ${VAR} are coerced", () => {
  const c = load(
    { ...minimal, server: { port: "${P}", requestTimeoutMs: "${T}", agentRpcTimeoutMs: "${R}", fs: "false" } },
    { P: "9999", T: "1000", R: "250" },
  );
  assert.equal(c.server.port, 9999);
  assert.equal(c.server.requestTimeoutMs, 1000);
  assert.equal(c.server.agentRpcTimeoutMs, 250);
  assert.equal(c.server.fs, false);
  // Coercion is not a licence to accept nonsense.
  assert.throws(() => load({ ...minimal, server: { port: "${P}" } }, { P: "http" }), /port/);
  assert.throws(() => load({ ...minimal, server: { agentRpcTimeoutMs: 0 } }), /agentRpcTimeoutMs/);
});

test("continuity is a boolean, and accepts a string from ${VAR}", () => {
  assert.equal(load(minimal).server.continuity, true);
  assert.equal(load({ ...minimal, server: { continuity: "false" } }).server.continuity, false);
  assert.equal(load({ ...minimal, server: { continuity: "${C}" } }, { C: "0" }).server.continuity, false);
  assert.throws(() => load({ ...minimal, server: { continuity: 1 } }), /continuity must be true or false/);
});

test("every numeric and boolean config field accepts env-expanded strings", () => {
  const server = {
    port: "${PORT}",
    requestTimeoutMs: "${REQUEST}",
    agentRpcTimeoutMs: "${RPC}",
    maxTerminals: "${TERMINALS}",
    terminalOutputBytes: "${OUTPUT}",
    terminalTimeoutMs: "${TERMINAL_TIMEOUT}",
    maxSessions: "${SESSIONS}",
    sessionTtlMs: "${SESSION_TTL}",
    forgetTtlMs: "${FORGET_TTL}",
    toolTimeoutMs: "${TOOL_TIMEOUT}",
    progressOutputLines: "${LINES}",
    maxContextFill: "${FILL}",
    fs: "${FS}",
    terminal: "${TERMINAL}",
    continuity: "${CONTINUITY}",
  };
  const env = {
    PORT: "9999", REQUEST: "1000", RPC: "250", TERMINALS: "3", OUTPUT: "4096",
    TERMINAL_TIMEOUT: "0", SESSIONS: "7", SESSION_TTL: "8000", FORGET_TTL: "9000",
    TOOL_TIMEOUT: "300", LINES: "4", FILL: "0.75", FS: "false", TERMINAL: "1",
    CONTINUITY: "0", WARMUP_TTL: "6000",
  };
  const c = load({
    server,
    agents: [{ name: "a", type: "claude", warmup: { prompt: "read", ttlMs: "${WARMUP_TTL}" } }],
  }, env);

  assert.deepEqual(
    Object.fromEntries(Object.keys(server).map((key) => [key, c.server[key]])),
    {
      port: 9999, requestTimeoutMs: 1000, agentRpcTimeoutMs: 250, maxTerminals: 3,
      terminalOutputBytes: 4096, terminalTimeoutMs: 0, maxSessions: 7, sessionTtlMs: 8000,
      forgetTtlMs: 9000, toolTimeoutMs: 300, progressOutputLines: 4, maxContextFill: 0.75,
      fs: false, terminal: true, continuity: false,
    },
  );
  assert.equal(c.agents[0].warmup.ttlMs, 6000);
});

test("limitPatterns compile to case-insensitive regexes and can be replaced", () => {
  const d = load(minimal);
  assert.ok(d.server.limitPatterns.some((re) => re.test("Claude USAGE LIMIT reached")));
  assert.ok(!d.server.limitPatterns.some((re) => re.test("connection reset by peer")));
  const custom = load({ ...minimal, server: { limitPatterns: ["^nope$"] } });
  assert.equal(custom.server.limitPatterns.length, 1);
});

test("loadConfig reads YAML and reports the file in errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp2api-"));
  const file = join(dir, "c.yaml");
  writeFileSync(file, "server:\n  port: 1234\n  host: ${K}\nagents:\n  - name: a\n    type: claude\n    model: opus\n");
  const c = loadConfig(file, { env: { K: "secret" } });
  assert.equal(c.server.port, 1234);
  assert.equal(c.server.host, "secret");
  assert.equal(c.agents[0].model, "opus");
  assert.equal(c.server.cwd, dir);

  writeFileSync(file, "agents: []\n");
  assert.throws(() => loadConfig(file, { env: {} }), new RegExp(file));
  assert.throws(() => loadConfig(join(dir, "gone.yaml")), /cannot read config/);
});

test("loadConfig presents an invalid limit pattern as a path-qualified ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp2api-regex-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, "server:\n  limitPatterns: ['[broken']\nagents:\n  - name: a\n    type: claude\n");
  assert.throws(
    () => loadConfig(file, { env: {} }),
    (error) => error instanceof ConfigError && error.message.includes(file)
      && error.message.includes('invalid regex "[broken"'),
  );
});
