import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = new URL("../bin/acp2api.js", import.meta.url);

async function runArgs(args, env = {}) {
  const child = spawn(process.execPath, [bin.pathname, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

async function occupy() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  return socket;
}

async function run(config, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "acp2api-cli-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  const child = spawn(process.execPath, [bin.pathname, "--config", file, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

test("--version needs neither config nor an agent", async () => {
  const result = await runArgs(["--version"], { ACP2API_CONFIG: "" });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(result, { code: 0, stdout: `${pkg.version}\n`, stderr: "" });
});

test("--init writes a secret-free minimal config and refuses overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp2api-init-"));
  const file = join(dir, "new.yaml");
  const first = await runArgs(["--init", file]);
  assert.equal(first.code, 0, first.stderr);
  const yaml = readFileSync(file, "utf8");
  assert.match(yaml, /name: claude\n    type: claude/);
  assert.doesNotMatch(yaml, /key|token|secret|model:/i);

  const second = await runArgs(["--init", file]);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists/);
  assert.equal(readFileSync(file, "utf8"), yaml);
});

test("--doctor JSON validates final configured options without warming or prompting", async () => {
  const root = mkdtempSync(join(tmpdir(), "acp2api-doctor-workspace-"));
  const workspace = join(root, "created-by-doctor");
  const sets = join(root, "sets");
  writeFileSync(sets, "");
  const result = await run({
    server: { cwd: workspace },
    agents: [{
      name: "fixture",
      type: "general",
      command: process.execPath,
      args: [new URL("fixtures/fake-agent.js", import.meta.url).pathname],
      env: { SET_CONFIG_CAPTURE_FILE: sets },
      model: "smart",
      warmup: { prompt: "must not run" },
    }],
  }, ["--doctor", "--json"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(workspace), true);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.agents[0].ok, true);
  assert.equal(report.agents[0].configOptions[0].category, "model");
  assert.equal(report.agents[0].configOptions[0].currentValue, "smart");
  assert.equal(readFileSync(sets, "utf8"), "model=smart\n");
});

test("--doctor catches reasoning selectors removed by configured model transitions", async () => {
  const unavailable = await run({
    agents: [{
      name: "fixture",
      type: "general",
      command: process.execPath,
      args: [new URL("fixtures/fake-agent.js", import.meta.url).pathname],
      model: "lite",
      reasoning: "high",
    }],
  }, ["--doctor", "--json"]);

  assert.equal(unavailable.code, 2);
  const report = JSON.parse(unavailable.stdout);
  assert.equal(report.agents[0].ok, false);
  assert.equal(report.agents[0].issues[0].code, "model_unavailable");
  assert.match(report.agents[0].issues[0].message, /offers no thought_level selector/);

  const rawUnavailable = await run({
    agents: [{
      name: "fixture",
      type: "general",
      command: process.execPath,
      args: [new URL("fixtures/fake-agent.js", import.meta.url).pathname],
      options: { model: "lite", effort: "high" },
    }],
  }, ["--doctor", "--json"]);

  assert.equal(rawUnavailable.code, 2);
  const rawReport = JSON.parse(rawUnavailable.stdout);
  assert.equal(rawReport.agents[0].issues[0].code, "model_unavailable");
  assert.match(rawReport.agents[0].issues[0].message, /offers no config option "effort"/);
});

test("--doctor reports unavailable configured values and missing CLIs", async () => {
  const unavailable = await run({
    agents: [{
      name: "fixture",
      type: "general",
      command: process.execPath,
      args: [new URL("fixtures/fake-agent.js", import.meta.url).pathname],
      model: "retired-model",
    }],
  }, ["--doctor", "--json"]);
  assert.equal(unavailable.code, 2);
  assert.equal(JSON.parse(unavailable.stdout).agents[0].issues[0].code, "model_unavailable");

  const missing = await run({
    agents: [{ name: "missing", type: "general", command: "/definitely/missing/acp-agent" }],
  }, ["--doctor", "--json"]);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stdout).agents[0].issues[0].code, "cli_not_installed");
});

test("--doctor --json keeps config failures machine-readable", async () => {
  const result = await runArgs(["--config", "/definitely/missing/acp2api.yaml", "--doctor", "--json"]);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.issues[0].code, "config_invalid");
});

test("API listener failures are one line and exit 2", async (t) => {
  const occupied = await occupy();
  t.after(() => occupied.close());
  const { port } = occupied.address();
  const result = await run({
    server: { port },
    agents: [{ name: "fixture", type: "general", command: process.execPath }],
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, new RegExp(`^cannot listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE.*\\n$`));
});

test("metrics listener failures are one line and exit 2", async (t) => {
  const occupied = await occupy();
  const api = await occupy();
  const { port: metricsPort } = occupied.address();
  const { port: apiPort } = api.address();
  await new Promise((resolve) => api.close(resolve));
  t.after(() => occupied.close());
  const result = await run({
    server: { port: apiPort, metricsAddr: `127.0.0.1:${metricsPort}` },
    agents: [{ name: "fixture", type: "general", command: process.execPath }],
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, new RegExp(`^cannot listen for metrics on 127\\.0\\.0\\.1:${metricsPort}: .*EADDRINUSE.*\\n$`));
});

test("--probe prints live options and capabilities without configuring or prompting", async () => {
  const root = mkdtempSync(join(tmpdir(), "acp2api-probe-workspace-"));
  const workspace = join(root, "not-created-yet");
  const result = await run({
    server: { cwd: workspace },
    agents: [{
      name: "fixture",
      type: "general",
      command: process.execPath,
      args: [new URL("fixtures/fake-agent.js", import.meta.url).pathname],
      env: { PROBE_GUARD: "1" },
      model: "smart",
      warmup: { prompt: "must not run" },
    }],
  }, ["--probe", "fixture"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(workspace), true);
  const output = JSON.parse(result.stdout);
  assert.equal(output.agent, "fixture");
  assert.deepEqual(output.configOptions[0], {
    id: "model",
    category: "model",
    type: "select",
    currentValue: "fast",
    values: [
      { value: "fast", name: "Fast" },
      { value: "smart", name: "Smart" },
      { value: "lite", name: "Lite (no reasoning selector)" },
    ],
  });
  assert.equal(output.capabilities.steering.supported, true);
  assert.deepEqual(output.capabilities.sessionCapabilities.close, {});
});

test("--probe reports the real spawn failure", async () => {
  const result = await run({
    agents: [{
      name: "missing",
      type: "general",
      command: "/definitely/missing/acp-agent",
    }],
  }, ["--probe", "missing"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /spawn failed: spawn \/definitely\/missing\/acp-agent ENOENT/);
  assert.match(result.stderr, /probe error: missing: spawn failed:/);
});
