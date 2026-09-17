#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../src/config.js";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "../src/server.js";
import { metricsServer } from "../src/metrics.js";
import { Agent } from "../src/agent.js";

const USAGE = `acp2api -- OpenAI-compatible HTTP server over ACP coding agents

  acp2api --config <file>     path to the YAML config (env: ACP2API_CONFIG)
  acp2api --version           print the installed package version
  acp2api --init <file>       create a minimal config; never overwrites
  acp2api --check             validate the config and exit
  acp2api --probe <agent>     print the agent's live ACP options; sends no prompt
  acp2api --doctor [--json]   check every agent without sending a prompt
  acp2api --help
`;

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const INITIAL_CONFIG = `# Minimal acp2api configuration. The CLI must already be logged in.\nserver:\n  cwd: ./work\nagents:\n  - name: claude\n    type: claude\n`;

const log = (level, message) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
};

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      version: { type: "boolean", short: "v" },
      init: { type: "string" },
      check: { type: "boolean" },
      probe: { type: "string" },
      doctor: { type: "boolean" },
      json: { type: "boolean" },
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

if (opts.version) {
  console.log(version);
  process.exit(0);
}

if (opts.init) {
  try {
    writeFileSync(opts.init, INITIAL_CONFIG, { encoding: "utf8", flag: "wx", mode: 0o600 });
    console.log(`created ${opts.init}`);
    process.exit(0);
  } catch (error) {
    if (error.code === "EEXIST") console.error(`init error: ${opts.init} already exists`);
    else console.error(`init error: ${error.message}`);
    process.exit(2);
  }
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
  if (opts.doctor && opts.json) {
    console.log(JSON.stringify({
      ok: false,
      config: file,
      agents: [],
      issues: [{ code: e instanceof ConfigError ? "config_invalid" : "could_not_verify", message: e.message ?? String(e) }],
    }, null, 2));
  } else {
    console.error(e instanceof ConfigError ? `config error: ${e.message}` : e);
  }
  process.exit(2);
}

if (opts.check) {
  log("info", `config ok: ${config.agents.length} agent(s): ${config.agents.map((a) => a.name).join(", ")}`);
  process.exit(0);
}

// The workspace is a bind-mounted volume that does not exist on a fresh host. An
// agent that cannot chdir into it fails at spawn, which reads as a broken adapter
// rather than a missing directory. Every entry point that can spawn goes through
// this first, including --probe.
function ensureWorkspaces() {
  for (const dir of new Set([config.server.cwd, ...config.agents.map((a) => a.cwd)])) {
    mkdirSync(dir, { recursive: true });
  }
}

try {
  ensureWorkspaces();
} catch (error) {
  if (opts.doctor) {
    const report = {
      ok: false,
      config: file,
      agents: [],
      issues: [{ code: "workspace_unavailable", message: error.message }],
    };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`failed: workspace_unavailable: ${error.message}`);
    process.exit(2);
  }
  throw error;
}

function doctorError(error) {
  const message = error?.message ?? String(error);
  if (error?.status === 401 || error?.code === "auth_required" || /auth(?:entication)? required|not logged in|login required/i.test(message)) {
    return { code: "login_required", message };
  }
  if (/\bENOENT\b|command not found|spawn failed/i.test(message)) return { code: "cli_not_installed", message };
  if (error?.code === "unsupported_option") return { code: "model_unavailable", message };
  if (error?.code === "unsupported_capability") return { code: "no_mcp_transport", message };
  return { code: "could_not_verify", message };
}

function inspectProbe(spec, probe) {
  const issues = [];
  for (const mcp of spec.mcpServers) {
    if (mcp.type !== "http" && mcp.type !== "sse") continue;
    if (!probe.capabilities.mcpCapabilities?.[mcp.type]) {
      issues.push({ code: "no_mcp_transport", message: `MCP server "${mcp.name}" needs ${mcp.type}` });
    }
  }
  return issues;
}

if (opts.doctor) {
  const report = { ok: true, config: file, agents: [] };
  for (const spec of config.agents) {
    let spawnError = null;
    const agent = new Agent(spec, config.server, (level, message) => {
      if (level === "error") spawnError = message;
    });
    try {
      // Unlike --probe, doctor validates the configured transition itself. Model
      // selection may add or remove later selectors, so the session/new snapshot
      // cannot prove that the final production settings are usable.
      const probe = await agent.probe({ configure: true });
      const issues = inspectProbe(spec, probe);
      report.agents.push({ agent: spec.name, ok: issues.length === 0, issues, ...probe });
      if (issues.length) report.ok = false;
    } catch (error) {
      report.ok = false;
      report.agents.push({ agent: spec.name, ok: false, issues: [doctorError(spawnError ? new Error(spawnError) : error)] });
    } finally {
      await agent.close();
    }
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`config: ok (${config.agents.length} agent(s))`);
    for (const agent of report.agents) {
      console.log(`${agent.ok ? "ok" : "failed"}: ${agent.agent}`);
      for (const issue of agent.issues) console.log(`  ${issue.code}: ${issue.message}`);
    }
  }
  process.exit(report.ok ? 0 : 2);
}

if (opts.probe) {
  const spec = config.agents.find((agent) => agent.name === opts.probe);
  if (!spec) {
    console.error(`probe error: no agent named "${opts.probe}"; configured: ${config.agents.map((a) => a.name).join(", ")}`);
    process.exit(2);
  }
  let spawnError = null;
  const agent = new Agent(spec, config.server, (level, message) => {
    // Keep successful probe output as one JSON document, but never silence the
    // spawn diagnostic that explains an otherwise generic connection close.
    if (level === "error") {
      spawnError = message;
      log(level, message);
    }
  });
  try {
    console.log(JSON.stringify(await agent.probe(), null, 2));
  } catch (error) {
    console.error(`probe error: ${spawnError ?? error.message}`);
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
