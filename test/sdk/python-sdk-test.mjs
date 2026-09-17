import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../src/agent.js";
import { normalizeConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "fixtures", "fake-agent.js");
const client = join(here, "python-sdk-client.py");
const python = process.argv[2];

if (!python) throw new Error("usage: node test/sdk/python-sdk-test.mjs <venv-python>");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited ${code ?? signal}\n${stdout}${stderr}`));
    });
  });
}

const config = normalizeConfig(
  {
    server: { host: "127.0.0.1", cwd: here },
    agents: [{ name: "fake", type: "general", command: process.execPath, args: [fixture] }],
  },
  { baseDir: here, env: {} },
);
const server = createServer(config, {
  agents: new Map(config.agents.map((spec) => [spec.name, new Agent(spec, config.server)])),
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = await run(python, [client], {
    env: {
      ...process.env,
      ACP2API_TEST_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
