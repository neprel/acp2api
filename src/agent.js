import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Progress } from "./progress.js";
import { Terminals } from "./terminal.js";

/**
 * The extension method for putting a prompt into a turn that is already running.
 *
 * Not in `acp.methods` because it is not in ACP: the spec defines no mid-turn
 * input at all. Both shipped adapters implement this one under the same name and
 * advertise it the same way, which is the whole reason a single code path can
 * serve both. See `Agent#inject`.
 */
const STEERING_METHOD = "_session/steering";

/** Thrown for anything the HTTP layer should report with a specific status. */
export class AgentError extends Error {
  constructor(message, status = 502, code = "agent_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Flattens a `SessionConfigSelect`'s options.
 *
 * The field is either a flat list of `{value, name}` or a list of
 * `{group, name, options}` -- there is no discriminator, so the presence of
 * `options` is what tells them apart.
 */
export function selectValues(options) {
  return (options ?? []).flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]));
}

/** True when `child` is inside `root` -- the guard for every filesystem callback. */
function within(root, child) {
  const rel = relative(root, resolve(root, child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * One ACP agent: a long-lived child process speaking ACP over stdio, plus one
 * session per prompt turn.
 *
 * The process is spawned lazily and kept alive, because starting `claude-agent-acp`
 * or `codex-acp` costs seconds; the SESSION is per request, because an OpenAI chat
 * completion is stateless and carries its full history in `messages`. Reusing one
 * session across requests would replay that history on top of the agent's own.
 */
export class Agent {
  #spec;
  #server;
  #log;
  #conn = null; // in-flight or established connection promise
  #closing = false;
  // sessionId -> the turn currently reading that session's updates.
  //
  // The SDK's own `ActiveSession` does this routing, and cannot be used here: its
  // constructor is private and the only way to obtain one is `session/new`. A
  // session RESUMED by id therefore has no way to receive its updates through it,
  // which would rule out `session/resume` and `session/fork` entirely. Routing by
  // hand costs this map and one notification handler.
  #sinks = new Map();
  #terminals = null; // built on demand, only when the capability is on
  // The warm session every new one is forked from: {session, warming, warmedAt}.
  // Null until something asks for a session, and only ever set when `warmup` is
  // configured. See #warmBase.
  #base = null;
  #metrics = null;

  constructor(spec, server, log = () => {}, metrics = null) {
    this.#spec = spec;
    this.#server = server;
    this.#log = log;
    // Optional. `turn()` is the one funnel every caller path goes through, so it is
    // the only place that sees a FAILED turn as well as a finished one -- and a
    // rate-limited turn is the single quota signal ACP offers for any agent.
    this.#metrics = metrics;
    if (server.terminal) {
      this.#terminals = new Terminals({
        cwd: spec.cwd,
        max: server.maxTerminals,
        outputByteLimit: server.terminalOutputBytes,
        timeoutMs: server.terminalTimeoutMs,
        log,
      });
    }
  }

  get name() {
    return this.#spec.name;
  }

  get spec() {
    return this.#spec;
  }

  #clientApp() {
    const { permission, fs: fsEnabled } = this.#server;
    const cwd = this.#spec.cwd;
    const app = acp
      .client({ name: "acp2api" })
      // One handler for every session on this agent, fanning out by id. An update
      // for a session with no turn reading it is dropped on purpose: it belongs to
      // a turn that has already ended, and there is nobody left to tell.
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        this.#sinks.get(params.sessionId)?.(params.update);
      })
      // No human is watching, so every permission prompt must be answered from
      // config. Match on `kind` rather than option id: ids are agent-specific.
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const wanted = permission === "allow" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
        for (const kind of wanted) {
          const opt = params.options.find((o) => o.kind === kind);
          if (opt) return { outcome: { outcome: "selected", optionId: opt.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
      });

    const terminals = this.#terminals;
    // A refusal has to be legible to the AGENT, which is the only thing that can
    // adapt to it. An ordinary thrown Error reaches it as a bare "Internal error"
    // with the reason stripped, so it retries the same forbidden thing.
    const legible = (fn) => {
      try {
        return fn();
      } catch (e) {
        const detail = e?.message ?? String(e);
        throw /unknown terminal/.test(detail)
          ? acp.RequestError.resourceNotFound(detail)
          : acp.RequestError.invalidParams(detail);
      }
    };
    if (terminals) {
      // Advertising `terminal` moves execution here: the agent stops running its
      // own commands and asks instead. Every guard the agent used to apply is now
      // this client's job -- see terminal.js.
      app
        .onRequest(acp.methods.client.terminal.create, ({ params }) =>
          legible(() => ({ terminalId: terminals.create(params) })),
        )
        .onRequest(acp.methods.client.terminal.output, ({ params }) =>
          legible(() => terminals.output(params.terminalId)),
        )
        .onRequest(acp.methods.client.terminal.waitForExit, async ({ params }) =>
          await legible(() => terminals.waitForExit(params.terminalId)),
        )
        .onRequest(acp.methods.client.terminal.kill, ({ params }) =>
          legible(() => {
            terminals.kill(params.terminalId);
            return {};
          }),
        )
        // Release is idempotent on purpose: an agent tidying up after a terminal
        // that already went is doing the right thing and must not be punished.
        .onRequest(acp.methods.client.terminal.release, ({ params }) => {
          terminals.release(params.terminalId);
          return {};
        });
    }

    if (!fsEnabled) return app;
    return app
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
        if (!within(cwd, params.path)) throw new Error(`path outside workspace: ${params.path}`);
        const text = await readFile(resolve(cwd, params.path), "utf8");
        if (params.line == null && params.limit == null) return { content: text };
        const lines = text.split("\n");
        const from = Math.max(0, (params.line ?? 1) - 1);
        return { content: lines.slice(from, params.limit ? from + params.limit : undefined).join("\n") };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        if (!within(cwd, params.path)) throw new Error(`path outside workspace: ${params.path}`);
        const target = resolve(cwd, params.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, params.content, "utf8");
        return {};
      });
  }

  /** Spawns and initializes the child, at most once per living process. */
  #connect() {
    // close() is terminal. Without this an in-flight request arriving during
    // shutdown would spawn a fresh CLI that nothing is left to reap.
    if (this.#closing) throw new AgentError(`${this.#spec.name}: agent is shut down`, 503, "agent_unavailable");
    if (this.#conn) return this.#conn;
    this.#conn = (async () => {
      const { command, args, env, name } = this.#spec;
      const child = spawn(command, args, {
        cwd: this.#spec.cwd,
        // stderr is inherited: agents log their own diagnostics there and losing
        // them makes an auth failure look like a hang.
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, ...env },
      });

      child.once("error", (e) => this.#log("error", `${name}: spawn failed: ${e.message}`));
      child.once("exit", (code, signal) => {
        // Drop the memo so the next request respawns rather than writing into a
        // dead pipe. A crashed agent must not take the whole server down.
        this.#conn = null;
        if (!this.#closing) this.#log("warn", `${name}: agent exited (code=${code} signal=${signal})`);
      });

      const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
      const connection = this.#clientApp().connect(stream);
      const init = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: this.#server.fs, writeTextFile: this.#server.fs },
          // Declaring this is what makes the agent route its shell work through
          // us. It is a transfer of responsibility, not an extra feature: from
          // here on, containment, timeouts and reaping are ours.
          ...(this.#terminals ? { terminal: true } : {}),
          // `plan_update` and `plan_removed` are sent ONLY to a client that asks for
          // them; without this the agent falls back to resending the whole plan, or
          // to sending nothing, and it looks like an agent that never plans. Asked
          // for only when there is something to render it with.
          ...(this.#server.progress === "reasoning" ? { plan: {} } : {}),
          // Not in the ACP schema: `claude-agent-acp` and `codex-acp` both gate a
          // richer Bash result on this `_meta` flag, sending the command's output
          // and its EXIT CODE as `_meta.terminal_output` / `terminal_exit` instead
          // of a fenced console block. The block alone would do -- progress.js
          // reads both -- but only this way is the exit code available at all.
          ...(this.#server.progress === "reasoning"
            ? { _meta: { terminal_output: true } }
            : {}),
        },
      });
      this.#log("info", `${name}: ${init.agentInfo?.name ?? command} v${init.agentInfo?.version ?? "?"} ready`);
      return { child, connection, init };
    })().catch((e) => {
      this.#conn = null;
      throw new AgentError(`${this.#spec.name}: cannot start "${this.#spec.command}": ${e.message}`, 503, "agent_unavailable");
    });
    return this.#conn;
  }

  /**
   * Applies `model`, `reasoning`, `mode` and any raw `options` to a fresh session.
   *
   * Selection is by semantic category (`model`, `thought_level`, `mode`) because the
   * option IDs differ between agents -- claude exposes `effort`, codex
   * `reasoning_effort`. A requested value that the agent does not offer is a hard
   * error: silently running on the wrong model is worse than a 400, since the caller
   * picked this agent name precisely to get that model.
   */
  async #applyOptions(ctx, session, wants) {
    let opts = session.options;
    if (opts.length === 0) return;

    // Model first, then reasoning: choosing a model CHANGES the option set. Claude
    // drops the `effort` selector entirely once Haiku is selected, so an id looked
    // up before the model was applied would no longer exist by the time it is used.
    const wanted = [
      ...(wants.model ? [{ category: "model", value: wants.model }] : []),
      ...(wants.reasoning ? [{ category: "thought_level", value: wants.reasoning }] : []),
      // How much the agent may do without asking. This is the autonomy control that
      // makes per-action permission prompts unnecessary: set the mode once, for the
      // session, rather than answering the same question for every edit.
      ...(wants.mode ? [{ category: "mode", value: wants.mode }] : []),
      ...Object.entries(wants.options ?? {}).map(([id, value]) => ({ id, value })),
    ];
    if (wanted.length === 0) return;

    for (const want of wanted) {
      const opt = want.id
        ? opts.find((o) => o.id === want.id)
        : opts.find((o) => o.category === want.category);
      if (!opt) {
        const what = want.id ? `config option "${want.id}"` : `${want.category} selector`;
        throw new AgentError(`${this.name}: agent offers no ${what}`, 400, "unsupported_option");
      }
      const { value } = want;
      const configId = opt.id;
      const payload = { sessionId: session.id, configId };
      if (opt.type === "boolean") {
        Object.assign(payload, { type: "boolean", value: value === true || value === "true" });
      } else {
        const choice = selectValues(opt.options).find((o) => o.value === String(value));
        if (!choice) throw new AgentError(`${this.name}: "${configId}" has no value "${value}"`, 400, "unsupported_option");
        Object.assign(payload, { value: choice.value });
      }
      const res = await ctx.request(acp.methods.agent.session.setConfigOption, payload);
      // The response carries the full refreshed set, and setting one option can
      // change another's choices (models restrict reasoning levels), so keep going
      // against the latest state rather than the snapshot from session/new. The
      // session keeps it too: a retained session is configured again on later turns.
      opts = res.configOptions ?? opts;
      session.options = opts;
    }
  }

  /**
   * The warm base every new session is forked from, warming it if needed.
   *
   * A cold session re-orients before it can do anything: it reads the project's
   * instructions, lists the tree, greps for its bearings. That is output tokens on
   * the calls, input tokens on their results, and all of it resident in the context
   * of every later turn -- paid again by every new conversation. Warming one
   * session and forking it pays it once per `ttlMs` instead.
   *
   * The warm-up is a REAL TURN against a real subscription. It is not free, and it
   * is only worth having when conversations start often enough to amortise it --
   * which is why it exists only when `warmup.prompt` is configured.
   *
   * Single-flight: two requests arriving cold must not warm two bases and leave one
   * of them unreferenced and resident.
   */
  async #warmBase(ctx) {
    const warmup = this.#spec.warmup;
    const stale = this.#base?.session && this.#base.warmedAt + warmup.ttlMs < Date.now();
    if (stale) {
      // The fork is a session in its own right, so retiring the parent does not
      // reach the conversations already forked from it.
      const old = this.#base.session;
      this.#base = null;
      this.#log("info", `${this.name}: warm base expired; closing ${old.id}`);
      await this.closeSession(old).catch(() => {});
    }
    if (this.#base?.warming) return await this.#base.warming;
    if (this.#base?.session) return this.#base.session;

    const warming = (async () => {
      const session = await this.#newSession(ctx);
      this.#log("info", `${this.name}: warming base session ${session.id}`);
      await this.turn(session, [{ type: "text", text: warmup.prompt }]);
      return session;
    })();
    this.#base = { session: null, warming, warmedAt: 0 };
    try {
      const session = await warming;
      this.#base = { session, warming: null, warmedAt: Date.now() };
      return session;
    } catch (e) {
      // A base that failed to warm must not be cached: the next request should try
      // again, or fall back to a cold session, rather than inherit the failure.
      this.#base = null;
      this.#log("warn", `${this.name}: warm-up failed (${e?.message ?? e}); sessions will start cold`);
      throw e;
    }
  }

  /**
   * Every MCP server a session should be opened with: the agent's own, plus any
   * the request brought.
   *
   * The extra one is how a caller's `tools` reach an agent at all -- there is no
   * `tools` field on `session/prompt`, so they are served as a tool server. It is
   * kept ON the session because `session/resume` fingerprints `mcpServers` and
   * compares: resuming with a different list is refused, and rightly so.
   */
  #mcpFor(extra) {
    return [...this.#spec.mcpServers, ...(extra ?? [])];
  }

  /** `session/new` plus the agent's configured options. The cold path. */
  async #newSession(ctx, extraMcp) {
    const builder = ctx.buildSession(this.#spec.cwd);
    for (const server of this.#mcpFor(extraMcp)) builder.withMcpServer(server);
    // `toRequest()` rather than `start()`: starting returns an `ActiveSession` that
    // registers its own update handler, and this class routes updates itself so a
    // resumed session can be read the same way a new one is. The builder is still
    // what shapes the request -- `mcpServers` has a fiddly array form.
    const res = await ctx.request(acp.methods.agent.session.new, builder.toRequest());
    const session = { id: res.sessionId, options: res.configOptions ?? [], agent: this.name, mcp: extraMcp ?? [] };
    try {
      await this.#applyOptions(ctx, session, this.#spec);
    } catch (e) {
      await this.closeSession(session);
      throw this.#classify(e);
    }
    return session;
  }

  /**
   * Opens an ACP session and configures it from the agent's own settings.
   *
   * Returned separately from `prompt` because the Responses API keeps a session
   * alive across requests -- that is the whole point of `previous_response_id`, and
   * the reason a continued turn sends only the new input instead of replaying the
   * history the agent already holds.
   *
   * With `warmup` configured this forks a warm base instead, so the agent starts
   * already oriented. Every failure on that path falls back to a cold session:
   * starting cold is slower and more expensive, and it is never wrong.
   */
  async openSession({ mcpServers } = {}) {
    const { connection, init } = await Promise.resolve().then(() => this.#connect());
    const ctx = connection.agent;

    // A warm base is shared by every conversation forked from it, so it cannot
    // carry ONE caller's tool server. A request that brings tools opens cold --
    // which is the same trade every other fork failure takes, and never wrong.
    if (mcpServers?.length) return await this.#newSession(ctx, mcpServers);

    if (this.#spec.warmup && init.agentCapabilities?.sessionCapabilities?.fork) {
      try {
        const base = await this.#warmBase(ctx);
        const res = await ctx.request(acp.methods.agent.session.fork, {
          sessionId: base.id,
          cwd: this.#spec.cwd,
          mcpServers: ctx.buildSession(this.#spec.cwd).toRequest().mcpServers,
        });
        const session = { id: res.sessionId, options: res.configOptions ?? [], agent: this.name };
        // Applied again rather than assumed inherited. A fork is a new session and
        // the protocol does not promise it carries the parent's selections; two
        // cheap local RPCs are a better bet than a thread silently running on the
        // wrong model.
        await this.#applyOptions(ctx, session, this.#spec);
        this.#log("info", `${this.name}: forked ${session.id} from warm base ${base.id}`);
        return session;
      } catch (e) {
        this.#log("warn", `${this.name}: fork failed (${e?.message ?? e}); opening a cold session`);
      }
    }
    return await this.#newSession(ctx);
  }


  /**
   * Restores a session this server closed earlier, by id.
   *
   * `session/resume` and not `session/load`: load replays the entire transcript
   * back as `session/update` notifications, which a bridge that renders updates
   * would re-emit as fresh output on every reconnect. Resume restores the session
   * and its MCP connections and replays nothing, which is what a continuation
   * wants.
   *
   * Returns null when the agent cannot resume -- it does not advertise the
   * capability, or the id is gone. Null means "open a new one", never an error:
   * a conversation whose session cannot be restored is a cold conversation, not a
   * failed request.
   */
  async resumeSession(sessionId, { mcpServers: extra } = {}) {
    if (!sessionId) return null;
    const conn = await Promise.resolve().then(() => this.#connect());
    if (!conn.init.agentCapabilities?.sessionCapabilities?.resume) return null;
    const ctx = conn.connection.agent;
    const builder = ctx.buildSession(this.#spec.cwd);
    for (const server of this.#mcpFor(extra)) builder.withMcpServer(server);
    // Named apart from the parameter on purpose: this is the FULL list the builder
    // produced, agent's own plus the caller's, and it is what the agent compares
    // its fingerprint against. Reusing the name shadowed nothing and simply failed
    // to parse -- reported, unhelpfully, twenty lines further down.
    const { cwd, mcpServers } = builder.toRequest();
    try {
      // The agent fingerprints cwd + mcpServers and compares them on resume, so
      // both are sent exactly as `session/new` sent them. A config change between
      // the two is precisely the case that should NOT resume.
      const res = await ctx.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers });
      return {
        id: res?.sessionId ?? sessionId,
        options: res?.configOptions ?? [],
        agent: this.name,
        mcp: extra ?? [],
      };
    } catch (e) {
      this.#log("info", `${this.name}: cannot resume ${sessionId} (${e?.message ?? e}); opening a new session`);
      return null;
    }
  }

  /** Ends a session and stops routing its updates. Safe to call twice. */
  async closeSession(session) {
    if (!session || session.closed) return;
    session.closed = true;
    this.#sinks.delete(session.id);
    const conn = this.#conn && (await this.#conn.catch(() => null));
    if (!conn?.init.agentCapabilities?.sessionCapabilities?.close) return;
    await conn.connection.agent
      .request(acp.methods.agent.session.close, { sessionId: session.id })
      .catch(() => {});
  }

  /**
   * Runs one prompt turn.
   *
   * `onEvent` receives `{type: "text"|"reasoning"|"tool_call", ...}` as the agent
   * streams, and is called before this resolves.
   *
   * `limit(text)` implements the OpenAI knobs ACP has no field for. It is consulted
   * after every text chunk and returns a stop reason -- `"max_tokens"` or
   * `"end_turn"` -- to cut the turn short, or a falsy value to continue. Cutting
   * means cancelling the ACP turn, which is why this lives here rather than in the
   * HTTP layer: a caller that stops reading does not stop the agent from working.
   */
  async prompt(blocks, options = {}) {
    const session = await this.openSession();
    try {
      return await this.turn(session, blocks, options);
    } finally {
      await this.closeSession(session);
    }
  }

  /**
   * Runs one turn inside an existing session.
   *
   * `overrides` re-applies config options before the turn -- this is how the
   * Responses API honours a per-request `reasoning.effort`, which chat completions
   * cannot express at all.
   */
  async turn(session, blocks, { signal, onEvent = () => {}, limit = null, overrides = null } = {}) {
    // Already gone before the turn began -- the caller hung up while the session
    // was being opened, which on a cold agent is seconds.
    //
    // This has to be checked rather than left to the listener below, because
    // `abort` has ALREADY been dispatched: `addEventListener` after the fact never
    // fires, so the cancel notification would never be sent. The turn would then
    // run to the end with nobody waiting for it, and an agent whose turn only ends
    // when it is told would never end at all. Measured as a CI job sitting for
    // five minutes against a log that simply stopped.
    if (signal?.aborted) {
      throw new AgentError(`${this.name}: cancelled before the turn started`, 499, "cancelled");
    }
    const { connection } = await Promise.resolve().then(() => this.#connect());
    const ctx = connection.agent;

    const onAbort = () => {
      ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.id }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Outside the try on purpose: `catch` and `finally` both read them, and a
    // declaration inside the block is invisible there. Getting this wrong turns a
    // clean 429 into a 500, which is the difference between a router trying the
    // next brain and a router calling it a crash.
    const startedAt = Date.now();
    // Overwritten by the catch. A turn that reaches the end of the try answered,
    // whatever its stop reason -- "ok" means the bridge did its job, not that the
    // agent liked the question.
    let outcome = "ok";

    try {
      if (overrides) await this.#applyOptions(ctx, session, overrides);

      let text = "";
      let reasoning = "";
      let cut = null; // stop reason imposed by `limit`, once it fires
      // Text seen since the last tool call. A coding agent writes a sentence
      // before each thing it does -- "SSH works, but my account is not in the
      // docker group, going through sudo" -- and those sentences are the running
      // commentary of the turn, not the answer to the question. Held here until
      // it is known which of the two this run turned out to be: see #commentary.
      let pending = "";
      // One per turn: the notes are transitions, and a shared instance would go
      // quiet about work the previous turn happened to mention.
      const progress =
        this.#server.progress === "reasoning" ? new Progress(this.#server.progressOutputLines) : null;
      // Progress notes travel in the reasoning channel, so they need the same
      // accumulate-and-emit that a thought chunk gets, and a blank line between a
      // note and prose that neither of them owns.
      const narrate = (note) => {
        const delta = reasoning === "" ? `${note}\n` : `\n${note}\n`;
        reasoning += delta;
        onEvent({ type: "reasoning", delta });
      };
      // Whether a text run that turns out to be commentary is moved OUT of the
      // answer and into the trace. Off by default: it changes what the caller
      // receives as the assistant's message, which is not a display preference.
      const asTrace = this.#server.commentary === "trace";
      let context = null; // {used, size} from the last usage_update, if any
      let cost = null; // {amount, currency} from the last usage_update, if any

      // Updates arrive as notifications on the same stream as the response, and
      // JSON-RPC keeps them in order, so everything the agent sent before it
      // answered has been handled by the time the request below resolves. Anything
      // it sends AFTER answering belongs to no turn and is dropped -- which is the
      // behaviour this had when the SDK's queue did the routing.
      const onUpdate = (u) => {
        // Once cut, ignore everything to the end. Cancellation is not instant --
        // the agent keeps sending for a moment, and appending that would undo the
        // truncation the caller asked for.
        if (cut) return;

        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          pending += u.content.text;
          if (asTrace) {
            // Nothing is emitted here: a run cannot be streamed before it is known
            // whether a tool call follows it, and a delta once sent cannot be taken
            // back out of the answer. `limit` reads the run in flight, because that
            // is what the answer will be -- a stop sequence inside commentary that
            // gets discarded is not a stop sequence in the reply.
            const verdict = limit?.(pending);
            if (verdict) {
              cut = verdict.stopReason;
              pending = verdict.text;
              onAbort();
            }
            return;
          }

          const before = text.length;
          text += u.content.text;
          const verdict = limit?.(text);
          if (verdict) {
            // `limit` may shorten the text -- a stop sequence is not part of the
            // answer -- so emit only what survived, then cancel and drain.
            cut = verdict.stopReason;
            text = verdict.text;
            if (text.length > before) onEvent({ type: "text", delta: text.slice(before) });
            onAbort();
            return;
          }
          onEvent({ type: "text", delta: u.content.text });
        } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
          reasoning += u.content.text;
          onEvent({ type: "reasoning", delta: u.content.text });
        } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
          // A tool call is what settles the question about the text before it: the
          // agent went back to work, so that run was commentary on the turn and not
          // its conclusion. Move it to the trace, where it belongs and where it is
          // useful WHILE the turn runs, and leave the answer clean.
          if (asTrace && pending.trim()) {
            narrate(pending.trim());
            pending = "";
          }
          // Progress only. These are the agent's OWN tool calls, already executed by
          // it -- not OpenAI `tool_calls` for the caller to run and answer.
          onEvent({ type: "tool_call", id: u.toolCallId, title: u.title, status: u.status, kind: u.kind });
          const note = progress?.note(u);
          if (note) narrate(note);
        } else if (progress && (u.sessionUpdate === "plan" || u.sessionUpdate === "plan_update")) {
          const note = progress.note(u);
          if (note) narrate(note);
        } else if (u.sessionUpdate === "usage_update") {
          if (Number.isFinite(u.size) && u.size > 0) {
            // The only signal before a session runs out of context for good. Kept as
            // the last reading rather than the largest: a compaction genuinely shrinks
            // it, and a session that just compacted has room again.
            context = { used: Number(u.used) || 0, size: Number(u.size) };
          }
          // Real money, when the agent knows it. claude-agent-acp sends Claude Code's
          // `total_cost_usd` here; codex-acp declares the field and never fills it.
          // CUMULATIVE for the session like the token counters, so it is settled into
          // a per-turn delta by the same baseline -- see `settleUsage` in server.js.
          if (Number.isFinite(u.cost?.amount)) {
            cost = { amount: Number(u.cost.amount), currency: u.cost.currency ?? null };
          }
        }
      };

      this.#sinks.set(session.id, onUpdate);
      // Opens the session to injection for as long as this turn runs, and only
      // that long. Nothing outside a turn may be steered in: there would be no
      // turn to fold the work into and nobody reading the updates.
      session.running = true;
      // A steered prompt joins THIS request. The agent folds it into the turn
      // already in flight, so this one response still reports the whole of it --
      // measured 2026-08-13 with a 45 s command in progress: the original work
      // finished, the injected command ran, and both appeared in this answer.
      const response = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.id,
        prompt: blocks,
      });
      if (asTrace) {
        // Whatever is still held when the turn ends had no tool call after it, so
        // it is the answer. Emitted in one delta because that is genuinely when it
        // became knowable -- see the note in the message-chunk branch above.
        text = pending.trim();
        if (text) onEvent({ type: "text", delta: text });
      }
      return {
        text,
        reasoning,
        // A turn cancelled by `limit` reports `cancelled`, which would reach the
        // caller as an ordinary "stop". Report what actually happened instead.
        stopReason: cut ?? response.stopReason,
        usage: response.usage ?? null,
        // How full this SESSION's context window is, when the agent says so.
        // Deliberately not part of the OpenAI response: it describes the session
        // rather than the turn, and it is the only warning anyone gets before the
        // agent runs out of context for good.
        context,
        // Cumulative session cost, when the agent reports one. Also kept out of the
        // OpenAI response -- there is no field for it there -- and settled into a
        // per-turn delta for whoever is counting.
        cost,
      };
    } catch (e) {
      const err = this.#classify(e);
      // The outcome vocabulary is the STATUS CONTRACT this bridge already publishes
      // to a failover chain -- 429 try the next brain, 502 fault, 503 could not
      // spawn, 504 no answer. Naming outcomes after it means the metric and the
      // router agree about what happened, instead of inventing a second taxonomy.
      outcome = { 429: "rate_limited", 401: "unauthenticated", 499: "cancelled", 503: "unavailable", 504: "timeout" }[err.status] ?? "error";
      throw err;
    } finally {
      this.#metrics?.recordOutcome({
        agent: this.name,
        outcome,
        seconds: (Date.now() - startedAt) / 1000,
      });
      // Stop reading this session's updates. Leaving the sink in place would let a
      // late chunk from this turn land in the next one's accumulator.
      this.#sinks.delete(session.id);
      // Shut the injection window even when the turn threw, so a later `inject`
      // cannot steer into a session with nothing reading it.
      session.running = false;
      // The signal outlives the turn -- on a retained session it belongs to one
      // request while the session serves many, so a leaked listener would cancel
      // somebody else's turn.
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Delivers a prompt INTO a turn that is already running.
   *
   * The whole point is that it does not wait for an answer: the answer belongs to
   * the turn this joins, and goes to whoever asked for that turn. What is returned
   * says only whether the agent took it.
   *
   * Refused, rather than queued, when no turn is running -- `session.running` is
   * true for the life of a turn. A prompt sent outside one would run with no sink
   * reading its updates: the work would happen, cost a real turn of a real
   * subscription, and be seen by nobody.
   *
   * ONE mechanism, and it is not in ACP
   * -----------------------------------
   * ACP itself has nothing here: a turn is a request/response, and the spec says
   * outright that it defines no way to send more input while one runs. `_session/
   * steering` is the extension both adapters implement -- claude-agent-acp calls it
   * "the agreed ACP steering wire protocol" in as many words -- advertised as
   * `_meta.steering.supported` at the TOP level of the initialize result, NOT
   * inside `agentCapabilities`. Grepping the wrong object is what once produced the
   * conclusion that codex could not steer at all.
   *
   * An agent that does not advertise it is refused rather than tried. That is not
   * caution for its own sake: codex was once sent a second `session/prompt` on the
   * theory that it would supersede the first, and it DEADLOCKS -- the original
   * request never resolves, the caller waits out its whole timeout (900 s where it
   * happened) and the turn's work goes with it.
   *
   * `idleBehavior: "promptRequired"` is what stops a miss from costing a turn: with
   * it, an agent that finds no live turn says so and does nothing. Without it the
   * documented default is to START one, which is the opposite of what a caller
   * joining a turn wants. Only claude honours it today; codex ignores the field and
   * still answers `startedNewTurn`, which is why that outcome is reported loudly
   * rather than quietly counted as success.
   *
   * @param {object} session an open session, mid-turn
   * @param {Array} blocks ACP content blocks
   * @returns {Promise<boolean>} whether it joined the running turn
   */
  async inject(session, blocks) {
    if (!session?.running) return false;
    const { connection, init } = await Promise.resolve().then(() => this.#connect());
    if (!init?._meta?.steering?.supported) return false;

    const res = await connection.agent.request(STEERING_METHOD, {
      sessionId: session.id,
      prompt: blocks,
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });

    // `injected` is the one that means what this method promises. The others are
    // named rather than lumped together, because they are different facts:
    //
    //   startedNewTurn  the turn ended underneath us and a WHOLE NEW ONE is now
    //                   running, unasked and unread. Worth a warning every time.
    //   promptRequired  nothing happened and the text is still the caller's to
    //                   send -- the outcome `idleBehavior` exists to produce.
    //   failed          codex could neither inject nor start anything.
    const outcome = res?.outcome;
    if (outcome === "injected") return true;
    if (outcome === "startedNewTurn") {
      this.#log("warn", `${this.name}: steering found no live turn and started a new one (${session.id})`);
      return false;
    }
    this.#log("info", `${this.name}: steering declined (${outcome ?? "no outcome"})`);
    return false;
  }

  /**
   * Turns an ACP failure into an HTTP status. The 429 branch is the reason this
   * server exists in a failover chain: ACP has no quota error code, so exhaustion
   * arrives as a plain message and only a pattern match can distinguish it from a
   * genuine fault. Anything unrecognised stays 502 -- a router must not treat a
   * broken agent as an exhausted one and burn its next provider.
   */
  #classify(e) {
    if (e instanceof AgentError) return e;
    const message = String(e?.data?.details ?? e?.message ?? e);
    const code = e?.code;
    if (code === -32000) return new AgentError(`${this.name}: not logged in (${message})`, 401, "auth_required");
    if (code === -32800) return new AgentError(`${this.name}: cancelled`, 499, "cancelled");
    if (this.#server.limitPatterns.some((re) => re.test(message))) {
      return new AgentError(`${this.name}: usage limit reached (${message})`, 429, "rate_limit_exceeded");
    }
    return new AgentError(`${this.name}: ${message}`, 502, "agent_error");
  }

  async close() {
    this.#closing = true;
    // Before the agent goes: a command it started outlives the process that asked
    // for it, and killing the CLI would leave the build it launched running with
    // nobody left to stop it.
    this.#terminals?.releaseAll();
    // The warm base belongs to nobody but this agent, so nothing else will close it.
    const base = this.#base?.session;
    this.#base = null;
    if (base) await this.closeSession(base).catch(() => {});
    const conn = this.#conn;
    this.#conn = null;
    if (!conn) return;
    const { child, connection } = await conn.catch(() => ({}));
    connection?.close();
    child?.kill();
  }
}
