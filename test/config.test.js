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

test("rejects malformed input rather than guessing", () => {
  assert.throws(() => load({ agents: [] }), /non-empty `agents`/);
  assert.throws(() => load({ ...minimal, server: { port: 0 } }), /port/);
  assert.throws(() => load({ ...minimal, server: { permission: "maybe" } }), /permission/);
  assert.throws(() => load({ agents: [{ name: "a", type: "nope" }] }), /type must be one of/);
  assert.throws(() => load({ agents: [{ type: "claude" }] }), /name is required/);
  assert.throws(() => load({ agents: [{ name: "a", type: "claude", args: "acp" }] }), /args must be a list/);
});

test("${VAR} expands, ${VAR:-default} falls back, an unset bare VAR is fatal", () => {
  assert.equal(expandEnv("a-${X}-b", { X: "1" }), "a-1-b");
  assert.equal(expandEnv("${MISSING:-fallback}", {}), "fallback");
  assert.equal(expandEnv("${EMPTY:-fallback}", { EMPTY: "" }), "fallback");
  assert.deepEqual(expandEnv({ k: ["${X}"] }, { X: "v" }), { k: ["v"] });
  // Silently starting with an empty api key would leave the port unauthenticated.
  assert.throws(() => expandEnv("${NOPE}", {}), ConfigError);
});

test("numbers that arrive as strings from ${VAR} are coerced", () => {
  const c = load({ ...minimal, server: { port: "${P}", requestTimeoutMs: "${T}", fs: "false" } }, { P: "9999", T: "1000" });
  assert.equal(c.server.port, 9999);
  assert.equal(c.server.requestTimeoutMs, 1000);
  assert.equal(c.server.fs, false);
  // Coercion is not a licence to accept nonsense.
  assert.throws(() => load({ ...minimal, server: { port: "${P}" } }, { P: "http" }), /port/);
});

test("continuity is a boolean, and accepts a string from ${VAR}", () => {
  assert.equal(load(minimal).server.continuity, true);
  assert.equal(load({ ...minimal, server: { continuity: "false" } }).server.continuity, false);
  assert.equal(load({ ...minimal, server: { continuity: "${C}" } }, { C: "0" }).server.continuity, false);
  assert.throws(() => load({ ...minimal, server: { continuity: 1 } }), /continuity must be true or false/);
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
