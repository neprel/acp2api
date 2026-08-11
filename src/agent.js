import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Progress } from "./progress.js";
import { Terminals } from "./terminal.js";

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

  constructor(spec, server, log = () => {}) {
    this.#spec = spec;
    this.#server = server;
    this.#log = log;
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
   * Opens an ACP session and configures it from the agent's own settings.
   *
   * Returned separately from `prompt` because the Responses API keeps a session
   * alive across requests -- that is the whole point of `previous_response_id`, and
   * the reason a continued turn sends only the new input instead of replaying the
   * history the agent already holds.
   */
  async openSession() {
    const { connection } = await Promise.resolve().then(() => this.#connect());
    const ctx = connection.agent;
    const builder = ctx.buildSession(this.#spec.cwd);
    // Tools belong to the AGENT, not to the request: the agent runs its own tool
    // loop, so MCP servers are declared once, when the session opens. There is no
    // per-request equivalent, which is why OpenAI's `tools` cannot map onto this.
    for (const server of this.#spec.mcpServers) builder.withMcpServer(server);

    // `toRequest()` rather than `start()`: starting returns an `ActiveSession` that
    // registers its own update handler, and this class routes updates itself so a
    // resumed session can be read the same way a new one is. The builder is still
    // what shapes the request -- `mcpServers` has a fiddly array form.
    const res = await ctx.request(acp.methods.agent.session.new, builder.toRequest());
    const session = {
      id: res.sessionId,
      // Tracked on the session rather than re-read from `session/new`, because that
      // snapshot goes stale the moment an option is set.
      options: res.configOptions ?? [],
      agent: this.name,
    };
    try {
      await this.#applyOptions(ctx, session, this.#spec);
    } catch (e) {
      await this.closeSession(session);
      throw this.#classify(e);
    }
    return session;
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
  async resumeSession(sessionId) {
    if (!sessionId) return null;
    const conn = await Promise.resolve().then(() => this.#connect());
    if (!conn.init.agentCapabilities?.sessionCapabilities?.resume) return null;
    const ctx = conn.connection.agent;
    const builder = ctx.buildSession(this.#spec.cwd);
    for (const server of this.#spec.mcpServers) builder.withMcpServer(server);
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
    const { connection } = await Promise.resolve().then(() => this.#connect());
    const ctx = connection.agent;

    const onAbort = () => {
      ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.id }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (overrides) await this.#applyOptions(ctx, session, overrides);

      let text = "";
      let reasoning = "";
      let cut = null; // stop reason imposed by `limit`, once it fires
      // One per turn: the notes are transitions, and a shared instance would go
      // quiet about work the previous turn happened to mention.
      const progress = this.#server.progress === "reasoning" ? new Progress() : null;
      // Progress notes travel in the reasoning channel, so they need the same
      // accumulate-and-emit that a thought chunk gets, and a blank line between a
      // note and prose that neither of them owns.
      const narrate = (note) => {
        const delta = reasoning === "" ? `${note}\n` : `\n${note}\n`;
        reasoning += delta;
        onEvent({ type: "reasoning", delta });
      };
      let context = null; // {used, size} from the last usage_update, if any

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
          // Progress only. These are the agent's OWN tool calls, already executed by
          // it -- not OpenAI `tool_calls` for the caller to run and answer.
          onEvent({ type: "tool_call", id: u.toolCallId, title: u.title, status: u.status, kind: u.kind });
          const note = progress?.note(u);
          if (note) narrate(note);
        } else if (progress && (u.sessionUpdate === "plan" || u.sessionUpdate === "plan_update")) {
          const note = progress.note(u);
          if (note) narrate(note);
        } else if (u.sessionUpdate === "usage_update" && Number.isFinite(u.size) && u.size > 0) {
          // The only signal before a session runs out of context for good. Kept as
          // the last reading rather than the largest: a compaction genuinely shrinks
          // it, and a session that just compacted has room again.
          context = { used: Number(u.used) || 0, size: Number(u.size) };
        }
      };

      this.#sinks.set(session.id, onUpdate);
      const response = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.id,
        prompt: blocks,
      });
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
      };
    } catch (e) {
      throw this.#classify(e);
    } finally {
      // Stop reading this session's updates. Leaving the sink in place would let a
      // late chunk from this turn land in the next one's accumulator.
      this.#sinks.delete(session.id);
      // The signal outlives the turn -- on a retained session it belongs to one
      // request while the session serves many, so a leaked listener would cancel
      // somebody else's turn.
      signal?.removeEventListener("abort", onAbort);
    }
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
    const conn = this.#conn;
    this.#conn = null;
    if (!conn) return;
    const { child, connection } = await conn.catch(() => ({}));
    connection?.close();
    child?.kill();
  }
}
