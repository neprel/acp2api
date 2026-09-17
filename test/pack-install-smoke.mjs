import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => (stdout += chunk));
    process.stderr.on("data", (chunk) => (stderr += chunk));
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}\n${stdout}${stderr}`));
    });
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

const tarballArg = process.argv[2];
if (!tarballArg) throw new Error("usage: node test/pack-install-smoke.mjs <tarball>");
const tarball = resolve(tarballArg);
const root = await mkdtemp(join(tmpdir(), "acp2api-pack-smoke-"));
const prefix = join(root, "prefix");
let serverProcess;

try {
  await run("npm", ["install", "--prefix", prefix, "--omit=optional", "--ignore-scripts", tarball]);
  const installed = join(prefix, "node_modules", "acp2api");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "acp2api");
  for (const shipped of [
    "bin/acp2api.js",
    "src/server.js",
    "src/agent.js",
    "src/config.js",
    "docs/compatibility.md",
    "docs/migration.md",
    "docs/operations.md",
    "examples/openai-sdk.mjs",
    "examples/openai_sdk.py",
  ]) {
    assert.ok((await readFile(join(installed, shipped))).length > 0, `tarball is missing ${shipped}`);
  }
  for (const optional of Object.keys(manifest.optionalDependencies ?? {})) {
    await assert.rejects(readFile(join(prefix, "node_modules", optional, "package.json")), /ENOENT/);
  }

  const port = await unusedPort();
  const config = join(root, "config.yaml");
  await writeFile(
    config,
    `server:\n  host: 127.0.0.1\n  port: ${port}\n  cwd: ${JSON.stringify(root)}\nagents:\n  - name: smoke-general\n    type: general\n    command: ${JSON.stringify(process.execPath)}\n    args: ["--version"]\n`,
  );
  const bin = join(prefix, "node_modules", ".bin", "acp2api");
  const checked = await run(bin, ["--config", config, "--check"], {
    env: { ...process.env, PATH: `${join(prefix, "node_modules", ".bin")}${delimiter}${process.env.PATH}` },
  });
  assert.match(checked.stdout, /config ok: 1 agent\(s\): smoke-general/);

  serverProcess = spawn(bin, ["--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  serverProcess.stdout.on("data", (chunk) => (diagnostics += chunk));
  serverProcess.stderr.on("data", (chunk) => (diagnostics += chunk));
  const deadline = Date.now() + 10_000;
  let health;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`installed CLI exited before health check\n${diagnostics}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.deepEqual(health, { status: "ok", agents: ["smoke-general"] });
  console.log(`installed ${basename(tarball)} without optional adapters and started general agent config`);
} finally {
  if (serverProcess?.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolvePromise) => serverProcess.once("exit", resolvePromise));
  }
  await rm(root, { recursive: true, force: true });
}
