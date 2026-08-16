import { createServer as createHttpServer } from "node:http";
import { Agent, AgentError } from "./agent.js";
import { ParamReporter } from "./params.js";
import {
  chunk,
  completion,
  deltaUsage,
  errorBody,
  makeLimiter,
  newCompletionId,
  parseChatRequest,
  RequestError,
  toPromptBlocks,
  usageChunk,
} from "./openai.js";
import { parseResponsesRequest, responseObject, ResponseStream } from "./responses.js";
import { commonPrefix, conversationKey, fingerprint, newResponseId, SessionStore } from "./sessions.js";
import { ToolBridge } from "./mcp.js";
import { Metrics } from "./metrics.js";
import { toolCallCompletion } from "./openai.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError("request body too large", 413, "payload_too_large"));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Builds the HTTP server.
 *
 * `agents` is injectable so tests can drive the HTTP layer without spawning
 * anything; in production it is built from the config.
 */
export function createServer(config, { agents, log = () => {} } = {}) {
  // Built whether or not anything scrapes it: recording is cheap, and an operator
  // who turns `metricsAddr` on wants the counters to have been running, not to
  // start from zero at the moment they looked.
  const metrics = new Metrics({
    agentLabels: Object.fromEntries(config.agents.map((a) => [a.name, a.labels ?? {}])),
  });
  const registry =
    agents ??
    new Map(config.agents.map((spec) => [spec.name, new Agent(spec, config.server, log, metrics)]));
  const params = new ParamReporter(config.server.unsupportedParams, log);
  const sessions = new SessionStore({
    max: config.server.maxSessions,
    ttlMs: config.server.sessionTtlMs,
    forgetTtlMs: config.server.forgetTtlMs,
    maxContextFill: config.server.maxContextFill,
    metrics,
    log,
  });
  // The caller's own tools, served to agents as an MCP server on this same port.
  const tools = new ToolBridge({ timeoutMs: config.server.toolTimeoutMs, log });
  // A conversation that goes takes its bench with it, or a call held open for a
  // caller that will never come back outlives everything that could answer it.
  sessions.onClose = (conv) => {
    if (conv.bench) tools.close(conv.bench);
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/health") return send(res, 200, { status: "ok", agents: [...registry.keys()] });
      // The MCP endpoint the AGENT connects to, not a client-facing route. The
      // token in the path names one conversation's tools and is the only thing
      // that addresses it.
      const mcp = /^\/mcp\/([A-Za-z0-9-]+)$/.exec(url.pathname);
      if (mcp) {
        if (req.method !== "POST") {
          // No server-initiated stream lives here, and the spec says a server that
          // does not offer one answers 405 rather than pretending.
          res.writeHead(405, { allow: "POST" });
          return res.end();
        }
        let message;
        try {
          message = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        }
        // Logged, because whether the agent ever ARRIVES here is the first question
        // asked when a caller's tools do not show up, and answering it by reasoning
        // about someone else's MCP client is guesswork.
        // The tool's NAME on a call, not just the method. Whether an agent reaches
        // for a caller's tool when it already has a native one of its own is a
        // question about cost -- a call through here ends the completion and comes
        // back as another request, where its own costs nothing -- and it is not a
        // question anyone should answer by guessing.
        const named = message?.method === "tools/call" ? ` ${message?.params?.name}` : "";
        log("info", `mcp: ${message?.method ?? "?"}${named} [${mcp[1].slice(0, 8)}]`);
        const answer = await tools.handle(mcp[1], message);
        // A notification takes no reply at all.
        if (!answer) {
          res.writeHead(202);
          return res.end();
        }
        return send(res, 200, answer);
      }


      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return send(res, 200, {
          object: "list",
          data: [...registry.values()].map((a) => ({
            id: a.name,
            object: "model",
            created: 0,
            owned_by: a.spec.type,
          })),
        });
      }


      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        return await handleCompletion(req, res, registry, config, log, params, sessions, tools, server);
      }

      if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
        return await handleResponse(req, res, registry, config, log, params, sessions, tools, server);
      }

      const stored = /^\/(?:v1\/)?responses\/([^/]+)$/.exec(url.pathname);
      if (stored) {
        const responseId = decodeURIComponent(stored[1]);
        if (req.method === "GET") {
          const body = sessions.response(responseId);
          if (!body) throw new RequestError(`no response with id ${responseId}`, 404, "not_found");
          return send(res, 200, body);
        }
        if (req.method === "DELETE") {
          const existed = await sessions.forget(responseId, registry);
          if (!existed) throw new RequestError(`no response with id ${responseId}`, 404, "not_found");
          return send(res, 200, { id: responseId, object: "response.deleted", deleted: true });
        }
      }

      return send(res, 404, errorBody(`no route for ${req.method} ${url.pathname}`, "not_found"));
    } catch (e) {
      const status = e.status ?? 500;
      log(status >= 500 ? "error" : "warn", `${req.method} ${url.pathname} -> ${status}: ${e.message}`);
      if (!res.headersSent) send(res, status, errorBody(e.message, e.code ?? "internal_error"));
      else res.end();
    }
  });

  // Handed to the caller so the process can start the metrics listener and so a
  // test can read the registry without a socket.
  server.metrics = metrics;

  server.on("close", async () => {
    // Retained sessions first: each is a live login, and closing the agent out from
    // under one leaves the CLI to be killed rather than told.
    await sessions.closeAll(registry).catch(() => {});
    for (const agent of registry.values()) agent.close?.();
  });
  return server;
}

/**
 * One turn of the Responses API.
 *
 * The shape differs from chat completions in the way that matters: the session
 * outlives the request. A new conversation opens one; `previous_response_id`
 * continues an existing one and sends only the new input, because the agent already
 * holds the history.
 */
async function handleResponse(req, res, registry, config, log, params, sessions, tools, httpServer) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    throw e instanceof RequestError ? e : new RequestError(`invalid JSON body: ${e.message}`);
  }

  const request = parseResponsesRequest(body);
  params.report(request.model, request.ignored);
  const agent = registry.get(request.model);
  if (!agent) {
    throw new RequestError(
      `model "${request.model}" not found; available: ${[...registry.keys()].join(", ")}`,
      404,
      "model_not_found",
    );
  }

  // Continuing pins the conversation to the agent that owns the session: a session
  // belongs to one child process and cannot be handed to another model.
  let convId;
  let conversation = null;
  if (request.previousResponseId) {
    conversation = sessions.find(request.previousResponseId);
    if (!conversation) {
      throw new RequestError(
        `previous_response_id ${request.previousResponseId} is unknown or its session has expired`,
        404,
        "not_found",
      );
    }
    if (conversation.agentName !== request.model) {
      throw new RequestError(
        `previous_response_id belongs to model "${conversation.agentName}", not "${request.model}"`,
        400,
        "invalid_request_error",
      );
    }
    convId = conversation.convId;
  } else {
    await sessions.prune(registry);
  }

  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.server.requestTimeoutMs);
  req.once("close", () => {
    if (res.writableEnded) return;
    clientGone = true;
    controller.abort();
  });

  const id = newResponseId();
  const created = Math.floor(Date.now() / 1000);
  const limit = makeLimiter({ maxTokens: request.maxTokens, stop: [] });
  const shape = (turn) =>
    responseObject({
      id,
      model: request.model,
      created,
      previousResponseId: request.previousResponseId,
      instructions: request.instructions,
      store: request.store,
      ignored: request.ignored,
      ...turn,
    });

  const serveTools = config.server.tools === "mcp" && request.tools.length > 0;

  // A turn of this conversation is suspended inside a tool call, and this request
  // carries its answer. Same shape as on chat completions -- the agent is still
  // inside the call it made, so nothing below (session, prompt, history) applies.
  if (conversation?.pending) {
    const pending = conversation.pending;
    const answered = request.toolResults.filter((r) => tools.resolve(pending.bench, r.id, r.text));
    if (answered.length === 0) {
      clearTimeout(timer);
      throw new RequestError(
        `${request.model}: this conversation is waiting for the result of a tool call; ` +
          `none of the function_call_output items sent match it`,
        409,
        "tool_result_expected",
      );
    }
    log("info", `${request.model}: answered ${answered.length} tool call(s); the turn continues`);
    pending.seen = { text: "", reasoning: "" };
    return await settleResponseTurn({
      res, tools, sessions, convId, pending, shape, id, stream: request.stream,
      timer, log, model: request.model, sessionsRecord: request.store,
    });
  }

  let session = conversation?.session ?? null;
  let opened = false;
  try {
    // Parked: the conversation gave back its session while nobody was continuing
    // it, and kept the id. `previous_response_id` still resolves, so restore it
    // rather than answering the caller from a stranger.
    if (!session && conversation?.sessionId) {
      session = await agent.resumeSession(conversation.sessionId);
      if (session) sessions.revive(convId, session);
      else {
        await sessions.discard(convId, registry);
        convId = null;
      }
    }
    // A bench must exist before the session opens: `session/new` is the only
    // place an MCP server can be declared, and `session/resume` compares the list
    // it is given against the one the session was built with.
    let bench = conversation ? sessions.bench(convId) : null;
    if (serveTools && !bench) {
      bench = tools.open(request.tools);
      session = null;
      if (convId) {
        await sessions.discard(convId, registry);
        convId = null;
      }
    } else if (bench) {
      tools.setTools(bench, request.tools);
    }

    if (!session) {
      session = await agent.openSession({ mcpServers: bench ? [benchServer(httpServer, bench)] : [] });
      opened = true;
      convId = sessions.open(request.model, session, { bench });
    }

    // `reasoning.effort` is re-applied per turn: on a continued conversation the
    // caller may raise it for one hard question and drop it again afterwards.
    const overrides = request.reasoning ? { reasoning: request.reasoning } : null;

    let stream = null;
    const start = () => {
      if (stream) return stream;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      stream = new ResponseStream((event) => write(res, event), {
        id,
        response: shape({ text: "", reasoning: "", stopReason: "end_turn", usage: null }),
      });
      stream.created();
      return stream;
    };

    if (bench) {
      const sink = makeSink();
      const running = agent.turn(session, request.blocks, {
        signal: controller.signal,
        limit,
        overrides,
        onEvent: (e) => sink.emit(e),
      });
      running.catch(() => {});
      return await settleResponseTurn({
        res, tools, sessions, convId, shape, id, stream: request.stream, timer, log,
        model: request.model, sessionsRecord: request.store,
        pending: { turn: running, sink, bench, seen: { text: "", reasoning: "" } },
      });
    }

    const turn = await agent.turn(session, request.blocks, {
      signal: controller.signal,
      limit,
      overrides,
      onEvent: (e) => {
        if (!request.stream || e.type === "tool_call") return;
        start().delta(e.type === "reasoning" ? "reasoning" : "message", e.delta);
      },
    });

    if (clientGone) return res.end();
    if (timedOut && !stream) throw timeoutError(request.model, config);

    const response = shape(settleUsage(sessions, convId, turn));
    // `store: false` means the caller will never continue from this id, so the
    // session it opened has no future -- keeping it would retain a live login.
    if (request.store) sessions.record(convId, id, response);
    else if (opened) await sessions.discard(convId, registry);

    if (!request.stream) return send(res, 200, response);
    start().completed(response);
    res.write("data: [DONE]\n\n");
    return res.end();
  } catch (e) {
    // A conversation that never produced a response is not a conversation. Leaving
    // it behind would retain a live login nobody can ever reach again.
    if (opened && convId) await sessions.discard(convId, registry);
    if (clientGone) {
      log("warn", `${request.model}: client disconnected`);
      return res.end();
    }
    if (timedOut && !(e instanceof AgentError && e.status === 429)) {
      log("warn", `${request.model}: timed out after ${config.server.requestTimeoutMs}ms`);
      if (!res.headersSent) return send(res, 504, errorBody(timeoutError(request.model, config).message, "timeout"));
      return res.end();
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const timeoutError = (model, config) =>
  new AgentError(`${model}: no answer within ${config.server.requestTimeoutMs}ms`, 504, "timeout");

async function handleCompletion(req, res, registry, config, log, params, sessions, tools, httpServer) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    throw e instanceof RequestError ? e : new RequestError(`invalid JSON body: ${e.message}`);
  }

  const {
    model,
    stream,
    includeUsage,
    maxTokens,
    stop,
    ignored,
    tools: declared,
    toolResults,
  } = parseChatRequest(body);
  // The caller declared tools and this server is willing to serve them. `off`
  // keeps the old behaviour, where they are dropped and reported as ignored.
  const serveTools = config.server.tools === "mcp" && declared.length > 0;
  // `tools` is not reported as dropped when it is about to be served -- `classify`
  // cannot know that, since whether they are honoured is a property of this
  // server's config rather than of the request.
  //
  // `tool_choice` STAYS reported, and that is deliberate. It is not honoured: the
  // agent decides what to call and when, and there is no way to tell it "you must
  // call this one" through a tool server. Quietly dropping it while serving the
  // tools beside it would tell a caller that asked for `required` that it got it.
  const reported = serveTools ? ignored.filter((k) => k !== "tools") : ignored;
  params.report(model, reported);
  const limit = makeLimiter({ maxTokens, stop });
  const agent = registry.get(model);
  if (!agent) {
    throw new RequestError(
      `model "${model}" not found; available: ${[...registry.keys()].join(", ")}`,
      404,
      "model_not_found",
    );
  }

  // One controller for both ends: the client hanging up cancels the ACP turn, and
  // so does the timeout, rather than leaving an agent working for nobody. The two
  // are tracked apart because they need opposite answers -- a timeout owes the
  // caller a 504, a vanished client owes it nothing.
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.server.requestTimeoutMs);
  req.once("close", () => {
    if (res.writableEnded) return;
    clientGone = true;
    controller.abort();
  });

  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const meta = { id, model, created };
  const timeout = () =>
    new AgentError(`${model}: no answer within ${config.server.requestTimeoutMs}ms`, 504, "timeout");

  // Continuity: reuse the session that already heard the start of this history and
  // send only what is new. Without it a stateless caller -- which is what the OpenAI
  // API asks every client to be -- restarts the agent on every message.
  const { systemId, turns, prefix } = conversationKey(body.messages);

  // A caller that can name its conversation gets the stronger form: the key is
  // asked first, and prefix matching is the fallback for callers that cannot.
  // Both are off when continuity is.
  const callerKey = config.server.conversationHeader
    ? String(req.headers[config.server.conversationHeader] ?? "").trim().slice(0, 512)
    : "";
  // `let`, not `const`: the suspended-turn branch below abandons a wedged
  // conversation and continues as if nothing had matched.
  let match = !config.server.continuity
    ? null
    : (callerKey && sessions.matchKey(model, callerKey, { whenBusy: config.server.busy })) ||
      sessions.matchPrefix(model, systemId, prefix);

  // A turn of this conversation is suspended inside a tool call, and this request
  // is the rest of it rather than a new one. Everything below -- session matching,
  // prompt building, `agent.turn` -- belongs to starting a turn, and none of it
  // applies: the turn is already running and simply needs its answer.
  if (match?.pending) {
    // ... unless the caller is plainly not answering it.
    //
    // A suspended turn waits for a tool result and has no other way out. If the
    // caller stops sending results -- a client that gave up mid-turn, an
    // iteration budget that ran out inside a tool call -- the conversation keeps
    // `pending` forever, and `resumeToolCall` answers every later message with
    //
    //   409 this conversation is waiting for the result of a tool call;
    //       none of the tool messages sent match it
    //
    // for the life of the process. `sessionTtlMs` does not help: a pending
    // conversation is deliberately neither parked nor evicted. Seen on
    // a production agent 2026-08-15, where one Mattermost thread answered 409 for
    // three hours while every other thread on the same agent worked.
    //
    // A request carrying NO tool messages at all is not a confused continuation,
    // it is a new message. Abandon the suspended turn and start a fresh one. A
    // request that does carry tool messages and simply matches none still gets
    // the 409 -- that caller believes it is answering something, and telling it
    // otherwise is the useful reply.
    if (toolResults.length === 0) {
      log("warn", `${model}: abandoning a turn suspended in a tool call -- the caller sent a new message instead of results${callerKey ? ` [${callerKey}]` : ""}`);
      // `discard`, not just clearing the two flags: the ACP session on the other
      // side is still suspended inside its own tool call, and handing it a fresh
      // prompt asks it to do two things at once. Closing it costs the thread's
      // context, which the abandoned turn had already lost.
      await sessions.discard(match.convId, registry);
      match = null;
    } else {
      return await resumeToolCall({
        req, res, match, sessions, tools, config, log, model, meta, stream,
        includeUsage, toolResults, timer, ignored: reported,
      });
    }
  }

  // "Join a turn already running, or do nothing." A caller that cannot know which
  // model a thread is on has to guess, and a guess that misses must be free --
  // otherwise it starts a whole turn of a real subscription for an answer nobody
  // is waiting for. 409 is what lets it try the next model.
  const injectOnly = Boolean(
    config.server.injectHeader && String(req.headers[config.server.injectHeader] ?? "").trim(),
  );
  if (injectOnly && !match?.busy) {
    clearTimeout(timer);
    return send(
      res,
      409,
      errorBody(`${model}: no turn is running for this conversation to join`, "no_running_turn"),
    );
  }

  // The named conversation is mid-turn and `busy: queue` says to join it rather
  // than start beside it. Only a KEYED caller reaches here: prefix matching cannot
  // identify a conversation whose transcript is still being written.
  if (match?.busy) {
    // Only what is new. The running turn has heard everything before it, and
    // resending the transcript would ask the agent to answer it twice.
    const queued = await agent.inject(match.session, toPromptBlocks(turns.slice(-1)));
    log("info", `${model}: ${queued ? "injected into" : "could not join"} the running turn [${callerKey}]`);
    // A turn was running, and the agent still would not take it -- it never claimed
    // it could queue prompts. Same answer as finding no turn at all, because it is
    // the same fact for the caller: not this one, try the next.
    if (!queued && injectOnly) {
      clearTimeout(timer);
      return send(
        res,
        409,
        errorBody(`${model}: this agent cannot take a prompt mid-turn`, "no_running_turn"),
      );
    }
    // This request is answered NOW, so its deadline is over. Every other exit from
    // this function clears the timer in a `finally`; leaving here without doing so
    // held the timer -- and with it the whole event loop -- for the full request
    // timeout after the reply had already been sent.
    clearTimeout(timer);
    // Answered immediately and empty, because the answer is not this request's:
    // it belongs to the turn that was joined, and reaches whoever is waiting on
    // it. A caller that treats this as the reply gets a blank message, which is
    // the honest shape of "delivered, nothing to say".
    if (!stream) {
      return send(res, 200, completion({ ...meta, text: "", stopReason: "end_turn", usage: null }));
    }
    // A well-formed empty stream, because a client that asked for one is parsing
    // SSE and a JSON body would be a protocol error on top of a blank answer.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    write(res, chunk({ ...meta, delta: { role: "assistant", content: "" } }));
    write(res, chunk({ ...meta, delta: {}, finishReason: "stop" }));
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  let convId = match?.convId ?? null;
  let session = match?.session ?? null;
  // Which kind of continuity found it. `matchKey` returns the session's prefix and
  // `matchPrefix` does not, so this is the discriminator -- and it decides whether a
  // turn nobody waited for may leave the session standing. See the catch below.
  const keyed = Boolean(match?.prefix);

  // `matchPrefix` found the session BY its prefix, so `matched` is exact.
  // `matchKey` did not look at the history at all -- a keyed caller may resend a
  // growing transcript, or may keep it on its own side and send one rolled-up
  // turn. Comparing here covers both: the first replays nothing, the second
  // replays nothing because nothing matches.
  const heard = match?.prefix ? commonPrefix(match.prefix, prefix) : (match?.matched ?? 0);
  const fresh = turns.slice(heard);
  // Declared out here because the catch reads it: a session opened by THIS request
  // has no id pointing at it and must never be left behind.
  let opened = false;

  try {
    // A parked conversation kept its id and gave back its session. Restoring it is
    // what makes going quiet cost nothing: the agent still holds everything it read
    // and planned, and only the new turn is sent. A resume that fails is not an
    // error -- it means this conversation is cold now, and the whole history has to
    // be replayed into a fresh session, which is why `blocks` is decided AFTER.
    if (!session && match?.sessionId) {
      session = await agent.resumeSession(match.sessionId);
      if (session) {
        sessions.revive(convId, session);
        log("info", `${model}: resumed ${match.sessionId}${callerKey ? ` [${callerKey}]` : ""}`);
      } else {
        await sessions.discard(convId, registry);
        convId = null;
      }
    }

    // A session's MCP servers are fixed when it opens: `session/new` takes them,
    // nothing adds one later, and `session/resume` compares the list it is given
    // against the one the session was built with. So a conversation that has to
    // serve the caller's tools and does not already have a bench needs a NEW
    // session -- the history is replayed into it, which is what a cold start does
    // anyway.
    let bench = match?.bench ?? null;
    if (serveTools && !bench) {
      bench = tools.open(declared);
      session = null;
      if (convId) {
        await sessions.discard(convId, registry);
        convId = null;
      }
    } else if (bench) {
      // Same conversation, possibly a different tool list. The agent listed them
      // when it connected and is not told they changed, so this only takes effect
      // for an agent that lists again -- which is why a caller is expected to send
      // a stable set for the life of a conversation.
      tools.setTools(bench, declared);
    }
    const benchServers = bench ? [benchServer(httpServer, bench)] : [];

    opened = !session;
    // Only the turns the session has not heard -- unless it is a fresh session,
    // which has heard nothing at all. The preamble goes with the session, so it is
    // sent once, when the session opens.
    const blocks = toPromptBlocks(
      opened ? body.messages : fresh.length > 0 ? fresh : turns.slice(-1),
    );

    if (opened) {
      await sessions.prune(registry);
      session = await agent.openSession({ mcpServers: benchServers });
      convId = sessions.open(model, session, { systemId, prefix, key: callerKey || null, bench });
      log(
        "info",
        `${model}: new session for ${prefix.length} message(s)${callerKey ? ` [${callerKey}]` : ""}` +
          (bench ? ` with ${declared.length} caller tool(s)` : ""),
      );
    } else {
      const how = keyed ? `keyed [${callerKey}]` : "by prefix";
      log("info", `${model}: continuing session ${how}, ${fresh.length} new of ${prefix.length} message(s)`);
    }
    sessions.setBusy(convId, true);

    // With tools in play a turn has TWO ways to end, so it is run through a sink
    // that can be handed to a later request. Without them, nothing here changes.
    if (bench) {
      return await runToolTurn({
        res, agent, session, blocks, controller, limit, sessions, tools, convId,
        bench, prefix, meta, stream, includeUsage, log, model, timer, ignored: reported,
        clientGone: () => clientGone,
        timedOut: () => timedOut,
        timeout,
      });
    }

    if (!stream) {
      const turn = await agent.turn(session, blocks, { signal: controller.signal, limit });
      if (clientGone) return res.end();
      // ACP reports cancellation as an ordinary stop reason, so without this a
      // timed-out turn would return 200 with whatever partial text it had -- which
      // a router downstream would count as success.
      if (timedOut) throw timeout();
      remember(sessions, convId, prefix, turn.text);
      return send(res, 200, completion({ ...meta, ...settleUsage(sessions, convId, turn), ignored: reported }));
    }

    // Headers go out only once the turn is under way. Sending them earlier would
    // commit to 200 before knowing whether the agent can even start, turning a
    // clean 429 -- the one an upstream router needs to fail over -- into a stream
    // that just stops.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      write(res, chunk({ ...meta, delta: { role: "assistant", content: "" } }));
    };

    const turn = await agent.turn(session, blocks, {
      signal: controller.signal,
      limit,
      onEvent: (e) => {
        // The agent's own tool calls are progress, not content: emitting them as
        // text would put "running bash" inside the answer.
        if (e.type === "tool_call") return;
        start();
        const delta = e.type === "reasoning" ? { reasoning_content: e.delta } : { content: e.delta };
        write(res, chunk({ ...meta, delta }));
      },
    });

    if (clientGone) return res.end();
    // Nothing was streamed yet, so the status is still ours to choose.
    if (timedOut && !started) throw timeout();

    remember(sessions, convId, prefix, turn.text);
    const settled = settleUsage(sessions, convId, turn);
    start(); // an empty turn still owes the client a well-formed stream
    // Mid-stream there is no status left to change, so say "length": the answer is
    // genuinely truncated, and that is the closest honest finish_reason.
    write(res, chunk({ ...meta, delta: {}, finishReason: timedOut ? "length" : finishOf(turn.stopReason) }));
    if (includeUsage && settled.usage) write(res, usageChunk({ ...meta, usage: settled.usage }));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    // A session that never answered has heard messages nobody can account for, so
    // it must not be offered to the next request. A brand new one goes entirely.
    //
    // With one exception, and it is the whole of steering. When the caller HANGS UP
    // or we stop waiting, nothing is wrong with the agent -- a human redirected it,
    // and the next message is the correction. Throwing the session away there
    // discards exactly the work worth keeping: the files it had read, the plan it
    // had built. So a session that already existed and was found BY KEY stays.
    //
    // Only by key. A prefix-matched session is found by claiming its recorded
    // history describes what the agent heard, and after an unanswered turn that
    // claim is false; continuing on it would be a lie about the conversation. A key
    // makes no claim about content, so an abandoned turn cannot invalidate it -- and
    // the unheard turns are simply resent, since `remember` never ran.
    const abandoned = clientGone || timedOut;
    if (convId && !(keyed && !opened && abandoned)) {
      await sessions.discard(convId, registry);
      convId = null;
    }
    if (clientGone) {
      log("warn", `${model}: client disconnected`);
      return res.end();
    }
    if (timedOut && !(e instanceof AgentError && e.status === 429)) {
      log("warn", `${model}: timed out after ${config.server.requestTimeoutMs}ms`);
      if (!res.headersSent) return send(res, 504, errorBody(timeout().message, "timeout"));
      return res.end();
    }
    throw e;
  } finally {
    clearTimeout(timer);
    // A turn suspended inside a tool call is still running, and the conversation
    // must stay busy for it: clearing the flag here would let the next request
    // start a SECOND turn on a session whose first one is merely waiting.
    if (convId && !sessions.isPending(convId)) sessions.setBusy(convId, false);
  }
}

/**
 * The MCP server entry that points an agent back at this process.
 *
 * Loopback on purpose, and never the configured `server.host`: the agent is a
 * child of this process and has no business reaching the bridge by whatever
 * address the outside world uses. `0.0.0.0` in particular is not an address
 * anything can connect TO.
 */
function benchServer(httpServer, token) {
  const at = httpServer?.address?.();
  const port = at?.port;
  const host = !at || at.address === "0.0.0.0" || at.address === "::" ? "127.0.0.1" : at.address;
  const authority = host.includes(":") ? `[${host}]` : host;
  return { type: "http", name: "acp2api-client-tools", url: `http://${authority}:${port}/mcp/${token}`, headers: [] };
}

/**
 * A turn's event stream, decoupled from whoever is listening to it.
 *
 * A turn that stops to ask the caller to run a tool OUTLIVES the request that
 * started it: the completion returns `tool_calls`, and the turn is picked up by
 * the next request carrying the results. In between, the agent may keep talking --
 * and nobody is attached. Those events are buffered rather than dropped, then
 * replayed to whoever attaches next, so no part of the turn is lost between two
 * halves of the same conversation.
 */
function makeSink() {
  let listener = null;
  const waiting = [];
  return {
    emit(event) {
      if (listener) listener(event);
      else waiting.push(event);
    },
    attach(fn) {
      listener = fn;
      for (const event of waiting.splice(0)) fn(event);
    },
    detach() {
      listener = null;
    },
  };
}

/**
 * Waits for whichever comes first: the turn ending, or the agent asking the caller
 * to run a tool.
 *
 * Both are ordinary outcomes of a turn that has tools available, and the caller
 * has to be told which happened -- an answer, or a bill of work.
 */
async function untilTurnOrToolCall(pending, tools) {
  let ended = null;
  const finished = pending.turn.then(
    (turn) => (ended = { turn }),
    (error) => (ended = { error }),
  );
  const parked = tools.nextPark(pending.bench).then(() => ({ calls: tools.parked(pending.bench) }));
  const outcome = await Promise.race([finished, parked]);
  // A turn that has already ended wins over a call that parked in the same tick:
  // a parked call belonging to a finished turn has nobody left to answer it.
  return ended ?? outcome;
}

/**
 * The Responses half of `settleToolTurn`: same suspended turn, same two ways out,
 * a different object to say it with.
 *
 * Kept apart rather than merged. The two APIs disagree about what a tool call IS
 * -- `tool_calls` on a message here, a `function_call` output item with its own id
 * there -- and about what a response is shaped like. Folding both into one
 * function would mean a parameter that switches between them at every step, which
 * reads worse than saying it twice.
 */
async function settleResponseTurn(o) {
  const { pending, tools, sessions, convId, shape, res } = o;

  // Written through, for the same reason as on chat completions: a turn that can
  // stop for a tool is still a turn someone is watching, and collecting its trace
  // to deliver at the end removes the live view from every caller that sends tools.
  let stream = null;
  const open = (body) => {
    if (stream) return stream;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    stream = new ResponseStream((event) => write(res, event), { id: o.id, response: body });
    stream.created();
    return stream;
  };
  pending.sink.attach((event) => {
    if (event.type === "text") pending.seen.text += event.delta;
    else if (event.type === "reasoning") pending.seen.reasoning += event.delta;
    else return;
    if (!o.stream) return;
    open(shape({ text: "", reasoning: "", stopReason: "end_turn", usage: null }))
      .delta(event.type === "reasoning" ? "reasoning" : "message", event.delta);
  });

  const outcome = await untilTurnOrToolCall(pending, tools);
  if (outcome.error) {
    sessions.setPending(convId, null);
    throw outcome.error;
  }

  const streamed = (body) => {
    clearTimeout(o.timer);
    if (!o.stream) return send(res, 200, body);
    // Text and reasoning have already gone out as deltas. The terminal event
    // carries the whole object, function calls included -- what a streaming client
    // does NOT get is an incremental `output_item.added` for the call itself,
    // because the turn produced it in one piece and inventing a delta sequence for
    // it would be theatre.
    open(body).completed(body);
    res.write("data: [DONE]\n\n");
    return res.end();
  };

  if (outcome.calls?.length) {
    tools.reported(pending.bench, outcome.calls.map((c) => c.id));
    pending.sink.detach();
    sessions.setPending(convId, pending);
    o.log("info", `${o.model}: turn is waiting on ${outcome.calls.length} client tool call(s)`);
    const asking = shape({
      text: pending.seen.text,
      reasoning: pending.seen.reasoning,
      stopReason: "end_turn",
      usage: null,
      calls: outcome.calls,
    });
    // RECORDED, even though the turn is not finished. This id is what the caller
    // puts in `previous_response_id` to send the result back, and without it there
    // is no way to reach the turn that is waiting for it -- a 404 instead of a
    // continuation.
    if (o.sessionsRecord) sessions.record(convId, o.id, asking);
    return streamed(asking);
  }

  sessions.setPending(convId, null);
  const turn = { ...outcome.turn, text: pending.seen.text, reasoning: pending.seen.reasoning };
  const body = shape(settleUsage(sessions, convId, turn));
  if (o.sessionsRecord) sessions.record(convId, o.id, body);
  return streamed(body);
}

/**
 * Runs a turn that has the caller's tools available to it, and answers whichever
 * way it ends.
 *
 * The difference from an ordinary turn is that this one can stop halfway with a
 * bill of work rather than an answer -- and when it does, it does NOT end. It sits
 * inside the MCP call, and the conversation keeps it.
 */
async function runToolTurn(o) {
  const sink = makeSink();
  const seen = { text: "", reasoning: "" };
  const turn = o.agent.turn(o.session, o.blocks, {
    signal: o.controller.signal,
    limit: o.limit,
    onEvent: (event) => sink.emit(event),
  });
  // Nothing must be awaited between creating the promise and attaching a handler
  // to it: an agent that fails instantly would otherwise reject unheard.
  turn.catch(() => {});
  const pending = { turn, sink, bench: o.bench, seen, prefix: o.prefix };
  return await settleToolTurn({ ...o, pending });
}

/**
 * Waits for a tool-enabled turn to reach its next boundary and answers the caller.
 *
 * Shared by the request that STARTS such a turn and by the one that resumes it,
 * because from here on they are the same thing: a turn in flight, a sink to read
 * it, and two ways it can end.
 */
async function settleToolTurn(o) {
  const { pending, tools, sessions, convId, meta, res } = o;

  // WRITTEN THROUGH, not accumulated. A turn that can stop for a tool is still a
  // turn someone is watching: the reasoning channel carries the agent's running
  // trace, and a caller renders it live. Collecting it and delivering it in one
  // piece at the end silently removed the progress bubble from every conversation
  // that sends tools -- which, for a gateway, is all of them. The answer arrived
  // as before and nothing failed, so nothing said so.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    write(res, chunk({ ...meta, delta: { role: "assistant", content: "" } }));
  };
  pending.sink.attach((event) => {
    if (event.type === "text") pending.seen.text += event.delta;
    else if (event.type === "reasoning") pending.seen.reasoning += event.delta;
    // The agent's own tool calls are progress, not content -- see the note in the
    // ordinary streaming path.
    else return;
    if (!o.stream) return;
    start();
    write(res, chunk({
      ...meta,
      delta: event.type === "reasoning" ? { reasoning_content: event.delta } : { content: event.delta },
    }));
  });

  const outcome = await untilTurnOrToolCall(pending, tools);

  if (outcome.error) {
    sessions.setPending(convId, null);
    throw outcome.error;
  }

  if (outcome.calls?.length) {
    // Handed over exactly once, so a second boundary in the same turn reports only
    // what is new.
    tools.reported(pending.bench, outcome.calls.map((c) => c.id));
    // Nobody is listening until the next request arrives; the sink keeps whatever
    // the agent says in the meantime.
    pending.sink.detach();
    sessions.setPending(convId, pending);
    clearTimeout(o.timer);
    o.log("info", `${o.model}: turn is waiting on ${outcome.calls.length} client tool call(s)`);
    const body = toolCallCompletion({
      ...meta,
      calls: outcome.calls,
      text: pending.seen.text,
      reasoning: pending.seen.reasoning,
      // Reported here too. A turn that stops to ask for a tool is still a turn
      // that was handed `temperature` and dropped it, and the caller has the same
      // right to know as it would on any other answer.
      ignored: o.ignored,
    });
    if (!o.stream) return send(res, 200, body);
    // Whatever it said before asking has already gone out as deltas; only the call
    // itself and the terminal frame are left.
    start();
    write(res, chunk({ ...meta, delta: { tool_calls: body.choices[0].message.tool_calls } }));
    write(res, chunk({ ...meta, delta: {}, finishReason: "tool_calls" }));
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // The turn is genuinely over. Everything it said across however many requests it
  // took is in `seen` -- the answer belongs to whoever asked last.
  sessions.setPending(convId, null);
  const turn = { ...outcome.turn, text: pending.seen.text, reasoning: pending.seen.reasoning };
  remember(sessions, convId, pending.prefix, turn.text);
  clearTimeout(o.timer);
  const settled = settleUsage(sessions, convId, turn);
  if (!o.stream) return send(res, 200, completion({ ...meta, ...settled, ignored: o.ignored }));
  // The text left with the deltas as it was produced; an empty turn still owes the
  // client a well-formed stream, which is what `start()` guarantees here.
  start();
  write(res, chunk({ ...meta, delta: {}, finishReason: finishOf(turn.stopReason) }));
  if (o.includeUsage && settled.usage) write(res, usageChunk({ ...meta, usage: settled.usage }));
  res.write("data: [DONE]\n\n");
  return res.end();
}

/**
 * Answers the tool calls a suspended turn is waiting on, and carries that same
 * turn forward.
 *
 * No session is opened, no prompt is sent, no history is replayed: the agent is
 * still inside the call it made, and all it needs is the result.
 */
async function resumeToolCall(o) {
  const { match, tools, toolResults, sessions } = o;
  // The turn that ends HERE was started by a different request, and that request's
  // `finally` -- the one that clears `busy` -- ran long ago, while the turn was
  // still suspended and correctly still busy. This path is the only place that can
  // clear it, and until 1.10.3 it did not: a conversation whose tool turn had
  // finished was left `busy: true, pending: null` with no live turn behind it.
  //
  // What that looked like was not an error. Every later message took the
  // `match?.busy` branch, `agent.inject` refused because there was no running turn
  // to join, and the bridge answered HTTP 200 with empty text -- an honest-looking
  // success. Hermes retried it three times and reported "the model returned no
  // content", which reads like a model fault. Seen on a production agent 2026-08-15.
  //
  // The condition matches the other `finally` exactly: still pending means the turn
  // asked for more tools and is genuinely still running.
  try {
    return await resumeToolCallInner(o);
  } finally {
    if (match.convId && !sessions.isPending(match.convId)) sessions.setBusy(match.convId, false);
  }
}

async function resumeToolCallInner(o) {
  const { match, tools, toolResults, sessions } = o;
  const pending = match.pending;
  const answered = toolResults.filter((r) => tools.resolve(pending.bench, r.id, r.text));
  if (answered.length === 0) {
    clearTimeout(o.timer);
    // Nothing here matched a call this server is holding. Saying so is better than
    // starting a second turn beside one that is still waiting -- which is what
    // silence would have caused.
    throw new RequestError(
      `${o.model}: this conversation is waiting for the result of a tool call; none of the tool messages sent match it`,
      409,
      "tool_result_expected",
    );
  }
  o.log("info", `${o.model}: answered ${answered.length} tool call(s); the turn continues`);
  // A fresh segment: what the caller receives now is what the agent says from here.
  pending.seen = { text: "", reasoning: "" };
  return await settleToolTurn({ ...o, pending, convId: match.convId, bench: pending.bench });
}

/**
 * Records what the session has now heard: the history it was given, plus the answer
 * it produced -- because that answer comes back as an `assistant` message in the
 * next request, and a prefix stopping short of it would resend it.
 *
 * If the caller alters that text (redaction, truncation) the fingerprint will not
 * match, and the shorter prefix wins instead: one redundant message, not a wrong
 * conversation. That graceful step down is why matching is by longest prefix rather
 * than by exact bookkeeping.
 */
function remember(sessions, convId, prefix, text) {
  if (!convId) return;
  sessions.extendPrefix(convId, [...prefix, fingerprint({ role: "assistant", content: text })]);
}

/**
 * Replaces a turn's CUMULATIVE session counters with what this turn alone cost, and
 * moves the session's baseline forward.
 *
 * ACP counts tokens across the whole session, and a retained session serves many
 * requests, so passing the counters through unchanged would bill every response for
 * the entire conversation so far. Call this exactly once per turn, before the
 * response is shaped -- calling it twice would report a delta of zero.
 */
function settleUsage(sessions, convId, turn) {
  if (!convId || !turn) return turn;
  // How full the window is describes the SESSION, so it is recorded even when the
  // turn reported no token counts at all.
  if (turn.context) sessions.rememberContext(convId, turn.context);
  // Cost is cumulative for the SESSION exactly like the token counters, so it is
  // settled the same way and in the same place. A figure that moved backwards is
  // read as the agent re-basing its own accounting, not as a refund.
  let cost = turn.cost;
  if (Number.isFinite(cost?.amount)) {
    const before = sessions.costBaseline(convId)?.amount ?? 0;
    sessions.rememberCost(convId, cost);
    cost = { ...cost, amount: cost.amount >= before ? cost.amount - before : cost.amount };
  }
  let usage;
  if (turn.usage) {
    usage = deltaUsage(turn.usage, sessions.usageBaseline(convId));
    sessions.rememberUsage(convId, turn.usage);
  }
  // Metrics are recorded HERE, and only here, for the same reason the settling is:
  // this function runs exactly once per turn and holds the only per-turn figures
  // that exist. Recording at the five call sites instead would be five chances to
  // forget one, and recording before the settling would export the whole
  // conversation's spend on every turn.
  sessions.metrics?.recordUsage({
    agent: sessions.agentOf(convId),
    usage,
    cost,
    context: turn.context,
  });
  if (!usage) return { ...turn, cost };
  return { ...turn, usage, cost };
}

const finishOf = (stopReason) =>
  ({ max_tokens: "length", max_turn_requests: "length", refusal: "content_filter" })[stopReason] ?? "stop";

function write(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
