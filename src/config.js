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
  // Loopback by default, and deliberately so: this bridge has no authentication
  // of its own and spawns agents that run commands and write files. Binding it
  // somewhere the network can reach is the operator's call to make -- and is
  // announced at startup, because it is worth seeing once.
  host: "127.0.0.1",
  port: 10021,
  cwd: ".",
  requestTimeoutMs: 600_000,
  permission: "allow",
  fs: true,
  // Run the agent's commands HERE instead of inside it.
  //
  // Advertising ACP's `terminal` capability makes an agent route its shell work
  // through this bridge: the output is ours as it happens, and `terminal/kill`
  // stops one command instead of `session/cancel` ending the whole turn.
  //
  // It is a transfer of responsibility rather than an added feature. Containment,
  // timeouts, output bounds and process reaping stop being the agent's problem and
  // become this one's -- see src/terminal.js. Off by default because an agent that
  // was sandboxing its own execution stops doing so the moment this is on.
  terminal: false,
  maxTerminals: 8,
  terminalOutputBytes: 1_048_576,
  // Wall clock for a single command. A command nobody kills and nobody waits for
  // outlives the turn, the session and the conversation; the agent decides when to
  // stop waiting, this decides when to stop running. 0 disables the bound.
  terminalTimeoutMs: 1_800_000,
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
  // When a conversation stops being a conversation at all.
  //
  // `sessionTtlMs` no longer ends anything: past it a conversation is PARKED --
  // it closes its ACP session, gives back the login and the memory, and keeps the
  // id, so the next message restores it with `session/resume` and the agent still
  // holds everything it had read. This is the bound that actually forgets, and it
  // can be generous because a parked conversation costs one map entry.
  //
  // Clamped up to `sessionTtlMs`: forgetting sooner than parking would mean the
  // park never happens.
  forgetTtlMs: 86_400_000,
  // What a request for a conversation whose turn is STILL RUNNING should do.
  //
  //   fork   the default. It gets a session of its own, because two turns cannot
  //          interleave inside one agent.
  //   queue  it is steered INTO the running turn, and the agent takes it at its
  //          next step.
  //
  // `queue` is what makes mid-turn steering possible at all. A coding-agent turn
  // runs for minutes behind a single completion, so "wait for the answer and send
  // the correction after" can mean waiting a quarter of an hour to redirect work
  // that went the wrong way in its first thirty seconds.
  //
  // It rests on the `_session/steering` extension, which both shipped adapters
  // implement and advertise as `_meta.steering.supported`; an agent without it
  // falls back to `fork`. MEASURED end to end on 2026-08-13, mid-way through a
  // 45-second command:
  //
  //   - the running prompt is NOT superseded and still reports the whole turn;
  //   - the work already under way finishes;
  //   - the steered instruction is carried out as well;
  //   - both appear in the answer to the ORIGINAL request.
  //
  // The request that delivered the injection is answered immediately with an empty
  // completion -- it was a notification, and the answer belongs to the turn it
  // joined. `fork` by default because this changes what a concurrent request means.
  //
  // What the agent does with the interrupted work is the MODEL's call, not the
  // protocol's: steering redirects, it does not append. An instruction phrased as
  // a replacement ("do exactly X") is a replacement, and the rest of the plan may
  // well be abandoned. Say "as well as what you are doing" when that is what is
  // meant.
  busy: "fork",
  // The header that marks a request as an INJECTION and nothing else: join a turn
  // already running, or do nothing at all.
  //
  // Without it an injection that misses -- wrong model, turn already finished,
  // conversation never opened -- falls through to the ordinary path and starts a
  // whole turn of its own. On a coding agent that is not a stray request: it is a
  // spent turn of a real subscription, doing work nobody asked for, streaming to a
  // caller that is not listening. Missing is the NORMAL case for a caller that has
  // to guess which model a thread is running on, so it must be free.
  //
  // Marked requests that find nothing answer 409, which is what makes guessing
  // safe: the caller can try the next model until one reports that it landed.
  // Empty disables the marker entirely.
  injectHeader: "x-acp2api-inject",
  // What to do with the `tools` a caller declares in its request.
  //
  //   mcp  the default. They are offered to the agent as an MCP server, and a
  //        call to one comes back to the caller as `finish_reason: "tool_calls"`.
  //   off  they are dropped, and the agent answers in prose. What every version
  //        before this one did.
  //
  // `session/prompt` has no `tools` field and never will -- an ACP agent runs its
  // own tool loop, and the protocol's answer to "where do tools come from" is
  // `mcpServers`, declared when the session opens. So the only way to serve a
  // caller's tools is to BE a tool server, which is what src/mcp.js is.
  //
  // The turn does not end at the call. It sits inside the MCP request, holding it
  // open, while the completion returns the call to the caller -- so when the
  // result arrives in the next request, the agent picks up exactly where it was
  // rather than re-planning from a summary. That is what an agent waiting on a
  // tool is supposed to look like.
  tools: "mcp",
  // How long a tool call may sit unanswered before the agent is told it failed.
  //
  // The caller has gone, or decided not to run it. Something has to end, because
  // on the other side of that call is an agent process holding a subscription
  // open with nothing to do.
  toolTimeoutMs: 300_000,
  // Reuse the session that already heard the start of an incoming history and send
  // only what is new. The OpenAI API asks every client to be stateless, so without
  // this the agent restarts on every message and re-reads a growing transcript.
  continuity: true,
  // The request header that names a conversation outright, when the caller can
  // send one. Continuity by prefix works only for callers that resend a growing
  // history; a caller that keeps the transcript on its own side and sends one
  // rolled-up turn per request has no growing prefix to match, and there is
  // nothing a session store can do about that. A stable key from the caller is
  // the answer, and it survives what prefix matching cannot: an edited system
  // prompt, a trimmed history, a compacted transcript.
  //
  // Empty string disables it. Prefix matching stays as the fallback either way.
  conversationHeader: "x-conversation-id",
  // Whether the agent's own activity -- its tool calls and its plan -- is narrated
  // back to the caller, and where.
  //
  //   off        the default. Only the answer and the agent's thinking travel.
  //   reasoning  activity is rendered as short notes in `reasoning_content`,
  //              alongside the thinking already there.
  //
  // It goes in the reasoning channel and never in the text, because a trace written
  // into the answer BECOMES the answer -- "running bash" would end up in what the
  // caller quotes, stores and replies to. `off` by default so a caller that has been
  // rendering reasoning as prose does not silently start showing tool traffic.
  progress: "off",
  // How many trailing lines of a command's own output to show in the trace, when
  // `progress` is on. 0 shows the command but never what it printed.
  //
  // The END of the output, because that is where a command says what happened: a
  // build prints a thousand lines of progress and one line of verdict. Small on
  // purpose -- this lands in a chat post, and an unbounded `npm test` buries the
  // whole turn.
  progressOutputLines: 6,
  // What to do with the sentences an agent writes BETWEEN its tool calls.
  //
  //   answer  the default. They are part of the assistant's message, exactly as
  //           the agent sent them.
  //   trace   a run of text followed by a tool call is moved into
  //           `reasoning_content` as it happens, and left out of the answer.
  //
  // A coding agent narrates itself -- "SSH works, but my account is not in the
  // docker group, going through sudo" -- and every one of those sentences ends up
  // glued into the final message, ahead of the actual conclusion. They are the
  // most readable account of the turn there is and the worst possible opening to
  // an answer someone scrolls back to.
  //
  // What settles which is which is a TOOL CALL: the agent went back to work, so
  // what it just said was commentary. Whatever is still unflushed when the turn
  // ends had nothing after it, and is the answer.
  //
  // The cost is that text cannot stream in this mode -- a run cannot be sent
  // before it is known whether a tool call follows, and a delta once sent cannot
  // be pulled back out of the answer. `answer` by default for that reason, and
  // because moving text out of the assistant's message is a change to what the
  // caller receives rather than a display preference.
  commentary: "answer",
  // How full a session's context window may get before it stops being reused, as a
  // fraction. 0 disables the check.
  //
  // The TTL above bounds how long a session sits idle and says nothing about how
  // large it has grown. The conversation continuity works hardest to keep -- one
  // continued every few minutes for days -- is exactly the one that grows into the
  // agent's own compaction, which is a model call out of the same subscription, and
  // then into a context window it cannot recover from at all. Retiring on fullness
  // costs one cold session; not retiring costs the conversation.
  //
  // Read from `usage_update`, which not every agent sends. An agent that stays
  // silent leaves the check inactive rather than being guessed at.
  maxContextFill: 0.85,
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
  for (const k of ["fs", "continuity"]) {
    if (typeof s[k] === "string") s[k] = s[k] !== "false" && s[k] !== "0";
  }

  req(Number.isInteger(s.port) && s.port > 0 && s.port < 65536, `server.port must be a port number, got ${s.port}`);
  req(typeof s.host === "string" && s.host.length > 0, "server.host must be a non-empty string");
  req(["allow", "deny"].includes(s.permission), `server.permission must be "allow" or "deny", got ${s.permission}`);
  req(
    ["ignore", "warn", "error"].includes(s.unsupportedParams),
    `server.unsupportedParams must be ignore, warn or error, got ${s.unsupportedParams}`,
  );
  req(Number.isInteger(s.requestTimeoutMs) && s.requestTimeoutMs > 0, "server.requestTimeoutMs must be a positive integer");
  req(Number.isInteger(s.maxSessions) && s.maxSessions > 0, "server.maxSessions must be a positive integer");
  req(typeof s.continuity === "boolean", "server.continuity must be true or false");
  req(["off", "reasoning"].includes(s.progress), `server.progress must be "off" or "reasoning", got ${s.progress}`);
  req(
    ["answer", "trace"].includes(s.commentary),
    `server.commentary must be "answer" or "trace", got ${s.commentary}`,
  );
  req(["fork", "queue"].includes(s.busy), `server.busy must be "fork" or "queue", got ${s.busy}`);
  req(["mcp", "off"].includes(s.tools), `server.tools must be "mcp" or "off", got ${s.tools}`);
  s.toolTimeoutMs = asInt(s.toolTimeoutMs);
  req(
    Number.isInteger(s.toolTimeoutMs) && s.toolTimeoutMs > 0,
    "server.toolTimeoutMs must be a positive integer",
  );
  req(
    Number.isInteger(s.progressOutputLines) && s.progressOutputLines >= 0,
    "server.progressOutputLines must be a non-negative integer",
  );
  req(typeof s.terminal === "boolean", "server.terminal must be true or false");
  req(Number.isInteger(s.maxTerminals) && s.maxTerminals > 0, "server.maxTerminals must be a positive integer");
  req(
    Number.isInteger(s.terminalOutputBytes) && s.terminalOutputBytes > 0,
    "server.terminalOutputBytes must be a positive integer",
  );
  req(
    Number.isInteger(s.terminalTimeoutMs) && s.terminalTimeoutMs >= 0,
    "server.terminalTimeoutMs must be a non-negative integer",
  );
  req(
    typeof s.maxContextFill === "number" && s.maxContextFill >= 0 && s.maxContextFill <= 1,
    `server.maxContextFill must be a fraction between 0 and 1, got ${s.maxContextFill}`,
  );
  req(typeof s.conversationHeader === "string", "server.conversationHeader must be a string");
  // Header names are compared against Node's lower-cased `req.headers`.
  s.conversationHeader = s.conversationHeader.toLowerCase();
  req(typeof s.injectHeader === "string", "server.injectHeader must be a string");
  s.injectHeader = s.injectHeader.toLowerCase();
  req(Number.isInteger(s.sessionTtlMs) && s.sessionTtlMs > 0, "server.sessionTtlMs must be a positive integer");
  req(Number.isInteger(s.forgetTtlMs) && s.forgetTtlMs > 0, "server.forgetTtlMs must be a positive integer");

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
  // Not validated against a list of names: the values are the AGENT's vocabulary,
  // and an id we do not recognise today is one it may add tomorrow. A wrong one
  // fails at session setup with the agent's own wording, which is more useful than
  // a guess made here.
  req(a.mode === undefined || typeof a.mode === "string", `${at}.mode must be a string`);

  return {
    name: a.name,
    type,
    command,
    args: a.args ?? spawnable?.args ?? [],
    env: a.env ?? {},
    // Resolved through the same rules as server.cwd so an agent can be pinned to
    // its own workspace (e.g. one repo per agent) without absolute paths.
    cwd: a.cwd ? (isAbsolute(a.cwd) ? a.cwd : resolve(server.cwd, a.cwd)) : server.cwd,
    // `model`, `reasoning` and `mode` are set by SEMANTIC CATEGORY, not by id:
    // claude calls its reasoning selector `effort` and codex calls it
    // `reasoning_effort`, but both report category `thought_level`. `options`
    // addresses anything else by raw id.
    model: a.model ?? null,
    reasoning: a.reasoning ?? null,
    // The agent's permission mode -- how much it may do without asking. Names are
    // the agent's own (`plan`, `acceptEdits`, `bypassPermissions` on claude), so
    // this is a passthrough by category rather than a vocabulary of ours.
    //
    // It is the alternative to answering a permission prompt per action: an
    // autonomous deployment sets the mode for the session and lets the agent work,
    // while a shared channel can pin it to `plan` and read what it proposes.
    mode: a.mode ?? null,
    warmup: normalizeWarmup(a.warmup, `${at}.warmup`),
    options: a.options ?? {},
    mcpServers: (a.mcpServers ?? []).map((m, j) => normalizeMcpServer(m, `${at}.mcpServers[${j}]`)),
    description: a.description ?? "",
  };
}

/**
 * Normalizes an agent's warm-up, or null when it has none.
 *
 * `prompt` is a real turn against a real subscription, run once per `ttlMs` and
 * forked by every conversation started in that window. It pays for itself only
 * when conversations start often enough, which is why there is no default: an
 * agent without this keeps opening cold sessions, which is slower and never wrong.
 *
 * `ttlMs` is how long the warmed context is still true. A base that read the
 * repository is stale the moment the repository moves, and nothing here can know
 * when that happened -- so this is a bet the operator makes, not a fact.
 */
function normalizeWarmup(warmup, at) {
  if (warmup === undefined || warmup === null) return null;
  req(warmup && typeof warmup === "object", `${at} must be a mapping`);
  req(typeof warmup.prompt === "string" && warmup.prompt.trim().length > 0, `${at}.prompt is required`);
  const ttlMs = warmup.ttlMs ?? 3_600_000;
  req(Number.isInteger(ttlMs) && ttlMs > 0, `${at}.ttlMs must be a positive integer`);
  return { prompt: warmup.prompt, ttlMs };
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
