import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = new URL("../bin/acp2api.js", import.meta.url);

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
  const result = await run({
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
  const output = JSON.parse(result.stdout);
  assert.equal(output.agent, "fixture");
  assert.deepEqual(output.configOptions[0], {
    id: "model",
    category: "model",
    type: "select",
    values: [
      { value: "fast", name: "Fast" },
      { value: "smart", name: "Smart" },
      { value: "lite", name: "Lite (no reasoning selector)" },
    ],
  });
  assert.equal(output.capabilities.steering.supported, true);
  assert.deepEqual(output.capabilities.sessionCapabilities.close, {});
});
