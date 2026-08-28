#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../src/config.js";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "../src/server.js";
import { metricsServer } from "../src/metrics.js";
import { Agent } from "../src/agent.js";

const USAGE = `acp2api -- OpenAI-compatible HTTP server over ACP coding agents

  acp2api --config <file>     path to the YAML config (env: ACP2API_CONFIG)
  acp2api --check             validate the config and exit
  acp2api --probe <agent>     print the agent's live ACP options; sends no prompt
`;

const log = (level, message) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
};

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      check: { type: "boolean" },
      probe: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const file = opts.config ?? process.env.ACP2API_CONFIG;
if (!file) {
  console.error(`no config given\n\n${USAGE}`);
  process.exit(2);
}

let config;
try {
  config = loadConfig(file);
} catch (e) {
  console.error(e instanceof ConfigError ? `config error: ${e.message}` : e);
  process.exit(2);
}

if (opts.check) {
  log("info", `config ok: ${config.agents.length} agent(s): ${config.agents.map((a) => a.name).join(", ")}`);
  process.exit(0);
}

if (opts.probe) {
  const spec = config.agents.find((agent) => agent.name === opts.probe);
  if (!spec) {
    console.error(`probe error: no agent named "${opts.probe}"; configured: ${config.agents.map((a) => a.name).join(", ")}`);
    process.exit(2);
  }
  const agent = new Agent(spec, config.server);
  try {
    console.log(JSON.stringify(await agent.probe(), null, 2));
  } catch (error) {
    console.error(`probe error: ${error.message}`);
    process.exitCode = 2;
  } finally {
    await agent.close();
  }
  process.exit(process.exitCode ?? 0);
}

// Said once, at startup, and not as a refusal: where to listen is the operator's
// decision. But there is no api key here -- authentication belongs to the router in
// front -- and this process spawns an agent that executes commands, so a non-
// loopback bind is worth reading once rather than discovering later.
if (!/^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(config.server.host)) {
  log("warn", `listening on ${config.server.host} -- there is no authentication here; put a router or proxy in front`);
}

// The workspace is a bind-mounted volume that does not exist on a fresh host. An
// agent that cannot chdir into it fails per-request, which reads as a broken agent
// rather than a missing directory.
for (const dir of new Set([config.server.cwd, ...config.agents.map((a) => a.cwd)])) {
  mkdirSync(dir, { recursive: true });
}

const server = createServer(config, { log });
server.on("error", (error) => {
  console.error(`cannot listen on ${config.server.host}:${config.server.port}: ${error.message}`);
  process.exit(2);
});
server.listen(config.server.port, config.server.host, () => {
  log("info", `listening on http://${config.server.host}:${config.server.port} (workspace ${config.server.cwd})`);
  for (const a of config.agents) {
    log("info", `  model "${a.name}" -> ${a.type}:${a.command} ${a.model ?? "(default model)"} ${a.reasoning ?? ""}`.trimEnd());
  }
});

// Metrics get their own listener, because the two ports answer different questions
// for different audiences: the API is unauthenticated and belongs on loopback, and
// a scraper has to reach the other one from somewhere else. Off unless asked for.
let metrics = null;
if (config.server.metricsAddr !== "off") {
  const { host: mHost, port: mPort } = config.server.metricsAddr;
  const displayHost = mHost.includes(":") ? `[${mHost}]` : mHost;
  metrics = metricsServer(server.metrics, { createServer: createHttpServer });
  metrics.on("error", (error) => {
    console.error(`cannot listen for metrics on ${displayHost}:${mPort}: ${error.message}`);
    process.exit(2);
  });
  metrics.listen(mPort, mHost, () => {
    log("info", `metrics on http://${displayHost}:${mPort}/metrics`);
  });
}

// Agents are child processes: leaving them behind on shutdown leaks a CLI holding
// an authenticated session, so close the server (which closes them) and only then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log("info", `${signal} -- shutting down`);
    metrics?.close();
    server.close(async () => {
      await server.whenClosed();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
