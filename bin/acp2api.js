#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const USAGE = `acp2api -- OpenAI-compatible HTTP server over ACP coding agents

  acp2api --config <file>     path to the YAML config (env: ACP2API_CONFIG)
  acp2api --check             validate the config and exit
`;

const log = (level, message) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
};

let opts;
try {
  ({ values: opts } = parseArgs({
    options: { config: { type: "string", short: "c" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
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
server.listen(config.server.port, config.server.host, () => {
  log("info", `listening on http://${config.server.host}:${config.server.port} (workspace ${config.server.cwd})`);
  for (const a of config.agents) {
    log("info", `  model "${a.name}" -> ${a.type}:${a.command} ${a.model ?? "(default model)"} ${a.reasoning ?? ""}`.trimEnd());
  }
});

// Agents are child processes: leaving them behind on shutdown leaks a CLI holding
// an authenticated session, so close the server (which closes them) and only then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log("info", `${signal} -- shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
