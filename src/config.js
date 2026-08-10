import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Built-in adapters per agent type. `general` has none on purpose: it is the escape
 * hatch for any other ACP-speaking CLI, so its command must be given.
 *
 * The adapters are dependencies of this package rather than global installs, so
 * their versions cannot drift with whatever `claude`/`codex` is on PATH.
 */
export const PRESETS = {
  claude: { pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
  codex: { pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
  general: null,
};

const require = createRequire(import.meta.url);

/**
 * Resolves a preset to a spawnable command.
 *
 * A dependency's bin lands in this package's `node_modules/.bin`, which is NOT on
 * PATH for a global install -- so `npm i -g acp2api` would break both headline
 * types if the bare name were spawned. Resolve the package and run its entry point
 * with the current node binary instead: no PATH lookup, no shebang, no exec bit.
 *
 * Falls back to the bare name when the adapter is absent (it is optional), so a
 * separately installed one still works and anything else fails as a clean 503.
 */
export function resolvePreset(preset) {
  try {
    const pkgJson = require.resolve(`${preset.pkg}/package.json`);
    const entry = require(pkgJson).bin[preset.bin];
    return { command: process.execPath, args: [join(dirname(pkgJson), entry)] };
  } catch {
    return { command: preset.bin, args: [] };
  }
}

/**
 * Errors that mean "this agent is out of quota, try another one". Matched against
 * the JSON-RPC error message of a failed prompt turn and turned into HTTP 429 so
 * an upstream router can fail over.
 *
 * ACP has no dedicated code for this -- agents surface it as a plain error string --
 * so this list is the whole detection mechanism. Add to it in the config rather
 * than editing here; `limitPatterns` replaces this default outright.
 */
export const DEFAULT_LIMIT_PATTERNS = [
  "rate.?limit",
  "usage limit",
  "quota",
  "too many requests",
  "\\b429\\b",
  "exceeded your current",
  "insufficient_quota",
];

const DEFAULTS = {
  host: "127.0.0.1",
  port: 10021,
  apiKey: "",
  cwd: ".",
  requestTimeoutMs: 600_000,
  permission: "allow",
  fs: true,
  // What to do with OpenAI parameters ACP cannot carry. `warn` is the default and
  // the only sane one: every client library sends `temperature` unasked, so `error`
  // would reject almost every request in the wild. See src/params.js for why some
  // parameters are refused regardless of this setting.
  unsupportedParams: "warn",
  // Retained ACP sessions behind the Responses API. Each is a live child process
  // holding a login, so both bounds matter: the cap stops an unbounded client from
  // spawning CLIs forever, and the TTL reaps conversations nobody returns to.
  maxSessions: 100,
  sessionTtlMs: 3_600_000,
};

/** Expands `${VAR}` and `${VAR:-fallback}` against `env`, recursively, in-place. */
export function expandEnv(value, env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name, fallback) => {
      const found = env[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`config references ${all} but ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  }
  return value;
}

export class ConfigError extends Error {}

/** Numeric strings only -- anything else is passed through to fail validation. */
const asInt = (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);

function req(cond, message) {
  if (!cond) throw new ConfigError(message);
}

/**
 * Validates a raw config object and fills in defaults. `baseDir` is what relative
 * `cwd` paths resolve against -- the config file's own directory, so a config is
 * portable between a checkout and a container without absolute paths in it.
 */
export function normalizeConfig(raw, { baseDir = process.cwd(), env = process.env } = {}) {
  req(raw && typeof raw === "object", "config must be a mapping");
  const input = expandEnv(raw, env);
  const s = { ...DEFAULTS, ...(input.server ?? {}) };
  // ${VAR} expansion always yields a string, so a port or timeout sourced from the
  // environment arrives as "10021" and would fail an Number.isInteger check.
  s.port = asInt(s.port);
  s.requestTimeoutMs = asInt(s.requestTimeoutMs);
  s.maxSessions = asInt(s.maxSessions);
  s.sessionTtlMs = asInt(s.sessionTtlMs);
  if (typeof s.fs === "string") s.fs = s.fs !== "false" && s.fs !== "0";

  req(Number.isInteger(s.port) && s.port > 0 && s.port < 65536, `server.port must be a port number, got ${s.port}`);
  req(typeof s.host === "string" && s.host.length > 0, "server.host must be a non-empty string");
  req(typeof s.apiKey === "string", "server.apiKey must be a string");
  req(["allow", "deny"].includes(s.permission), `server.permission must be "allow" or "deny", got ${s.permission}`);
  req(
    ["ignore", "warn", "error"].includes(s.unsupportedParams),
    `server.unsupportedParams must be ignore, warn or error, got ${s.unsupportedParams}`,
  );
  req(Number.isInteger(s.requestTimeoutMs) && s.requestTimeoutMs > 0, "server.requestTimeoutMs must be a positive integer");
  req(Number.isInteger(s.maxSessions) && s.maxSessions > 0, "server.maxSessions must be a positive integer");
  req(Number.isInteger(s.sessionTtlMs) && s.sessionTtlMs > 0, "server.sessionTtlMs must be a positive integer");

  const patterns = s.limitPatterns ?? DEFAULT_LIMIT_PATTERNS;
  req(Array.isArray(patterns), "server.limitPatterns must be a list of regex strings");

  const server = {
    ...s,
    cwd: isAbsolute(s.cwd) ? s.cwd : resolve(baseDir, s.cwd),
    limitPatterns: patterns.map((p) => new RegExp(p, "i")),
  };

  req(Array.isArray(input.agents) && input.agents.length > 0, "config needs a non-empty `agents` list");
  const seen = new Set();
  const agents = input.agents.map((a, i) => normalizeAgent(a, i, server, seen));

  return { server, agents };
}

function normalizeAgent(a, i, server, seen) {
  const at = `agents[${i}]`;
  req(a && typeof a === "object", `${at} must be a mapping`);
  req(typeof a.name === "string" && a.name.length > 0, `${at}.name is required`);
  req(!seen.has(a.name), `${at}.name "${a.name}" is used more than once -- names are the OpenAI model ids and must be unique`);
  seen.add(a.name);

  const type = a.type ?? "general";
  req(type in PRESETS, `${at}.type must be one of ${Object.keys(PRESETS).join(", ")}, got ${type}`);
  // An explicit command wins over the preset and skips resolution entirely, so a
  // custom build of an adapter can be pointed at without touching this package.
  const spawnable = a.command ? null : PRESETS[type] && resolvePreset(PRESETS[type]);
  const command = a.command ?? spawnable?.command;
  req(command, `${at}.command is required for type "${type}"`);

  req(a.args === undefined || Array.isArray(a.args), `${at}.args must be a list`);
  req(a.env === undefined || (a.env && typeof a.env === "object"), `${at}.env must be a mapping`);
  req(a.mcpServers === undefined || Array.isArray(a.mcpServers), `${at}.mcpServers must be a list`);
  req(a.options === undefined || (a.options && typeof a.options === "object"), `${at}.options must be a mapping of configOption id to value`);

  return {
    name: a.name,
    type,
    command,
    args: a.args ?? spawnable?.args ?? [],
    env: a.env ?? {},
    // Resolved through the same rules as server.cwd so an agent can be pinned to
    // its own workspace (e.g. one repo per agent) without absolute paths.
    cwd: a.cwd ? (isAbsolute(a.cwd) ? a.cwd : resolve(server.cwd, a.cwd)) : server.cwd,
    // `model` and `reasoning` are set by SEMANTIC CATEGORY, not by id: claude calls
    // its reasoning selector `effort` and codex calls it `reasoning_effort`, but both
    // report category `thought_level`. `options` addresses anything else by raw id.
    model: a.model ?? null,
    reasoning: a.reasoning ?? null,
    options: a.options ?? {},
    mcpServers: (a.mcpServers ?? []).map((m, j) => normalizeMcpServer(m, `${at}.mcpServers[${j}]`)),
    description: a.description ?? "",
  };
}

/**
 * Normalizes one MCP server entry into the exact shape `session/new` wants.
 *
 * ACP takes `env` and `headers` as ARRAYS of `{name, value}`, which is miserable to
 * write by hand, so a plain mapping is accepted here and converted. The stdio
 * variant carries no `type` discriminator and requires `args` and `env` to be
 * present even when empty -- omitting them is rejected by the agent, not by us.
 *
 * MCP is how an ACP agent gets tools at all: the agent runs its own tool loop, so
 * there is nothing to pass per request. Tools are a property of the agent.
 */
function normalizeMcpServer(m, at) {
  req(m && typeof m === "object", `${at} must be a mapping`);
  req(typeof m.name === "string" && m.name, `${at}.name is required`);
  const pairs = (v, what) => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    req(v && typeof v === "object", `${at}.${what} must be a mapping or a list of {name, value}`);
    return Object.entries(v).map(([name, value]) => ({ name, value: String(value) }));
  };

  const type = m.type ?? (m.url ? "http" : "stdio");
  if (type === "http" || type === "sse") {
    req(typeof m.url === "string" && m.url, `${at}.url is required for type "${type}"`);
    return { type, name: m.name, url: m.url, headers: pairs(m.headers, "headers") };
  }
  if (type === "stdio") {
    req(typeof m.command === "string" && m.command, `${at}.command is required for type "stdio"`);
    return { name: m.name, command: m.command, args: m.args ?? [], env: pairs(m.env, "env") };
  }
  throw new ConfigError(`${at}.type must be http, sse or stdio, got ${type}`);
}

/** Reads and normalizes a YAML (or JSON -- YAML is a superset) config file. */
export function loadConfig(file, { env = process.env } = {}) {
  const path = resolve(file);
  let raw;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read config ${path}: ${e.message}`);
  }
  try {
    return normalizeConfig(raw, { baseDir: dirname(path), env });
  } catch (e) {
    throw e instanceof ConfigError ? new ConfigError(`${path}: ${e.message}`) : e;
  }
}
