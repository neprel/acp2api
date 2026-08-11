import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Constant-time compare that does not leak length through an early return. */
function secretEquals(a, b) {
  const x = Buffer.from(a ?? "", "utf8");
  const y = Buffer.from(b ?? "", "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

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
  const registry =
    agents ??
    new Map(config.agents.map((spec) => [spec.name, new Agent(spec, config.server, log)]));
  const params = new ParamReporter(config.server.unsupportedParams, log);
  const sessions = new SessionStore({
    max: config.server.maxSessions,
    ttlMs: config.server.sessionTtlMs,
    forgetTtlMs: config.server.forgetTtlMs,
    maxContextFill: config.server.maxContextFill,
    log,
  });

  const authorized = (req) => {
    if (!config.server.apiKey) return true;
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    // x-api-key too: Anthropic-style clients send that instead, and both are
    // pointing at the same server here.
    return secretEquals(bearer, config.server.apiKey) || secretEquals(req.headers["x-api-key"], config.server.apiKey);
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/health") return send(res, 200, { status: "ok", agents: [...registry.keys()] });
      if (!authorized(req)) return send(res, 401, errorBody("invalid api key", "invalid_api_key", "authentication_error"));

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
        return await handleCompletion(req, res, registry, config, log, params, sessions);
      }

      if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
        return await handleResponse(req, res, registry, config, log, params, sessions);
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
async function handleResponse(req, res, registry, config, log, params, sessions) {
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
    if (!session) {
      session = await agent.openSession();
      opened = true;
      convId = sessions.open(request.model, session);
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

async function handleCompletion(req, res, registry, config, log, params, sessions) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    throw e instanceof RequestError ? e : new RequestError(`invalid JSON body: ${e.message}`);
  }

  const { model, stream, includeUsage, maxTokens, stop, ignored } = parseChatRequest(body);
  params.report(model, ignored);
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
  const match = !config.server.continuity
    ? null
    : (callerKey && sessions.matchKey(model, callerKey)) || sessions.matchPrefix(model, systemId, prefix);
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

    opened = !session;
    // Only the turns the session has not heard -- unless it is a fresh session,
    // which has heard nothing at all. The preamble goes with the session, so it is
    // sent once, when the session opens.
    const blocks = toPromptBlocks(
      opened ? body.messages : fresh.length > 0 ? fresh : turns.slice(-1),
    );

    if (opened) {
      await sessions.prune(registry);
      session = await agent.openSession();
      convId = sessions.open(model, session, { systemId, prefix, key: callerKey || null });
      log("info", `${model}: new session for ${prefix.length} message(s)${callerKey ? ` [${callerKey}]` : ""}`);
    } else {
      const how = keyed ? `keyed [${callerKey}]` : "by prefix";
      log("info", `${model}: continuing session ${how}, ${fresh.length} new of ${prefix.length} message(s)`);
    }
    sessions.setBusy(convId, true);

    if (!stream) {
      const turn = await agent.turn(session, blocks, { signal: controller.signal, limit });
      if (clientGone) return res.end();
      // ACP reports cancellation as an ordinary stop reason, so without this a
      // timed-out turn would return 200 with whatever partial text it had -- which
      // a router downstream would count as success.
      if (timedOut) throw timeout();
      remember(sessions, convId, prefix, turn.text);
      return send(res, 200, completion({ ...meta, ...settleUsage(sessions, convId, turn), ignored }));
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
    if (convId) sessions.setBusy(convId, false);
  }
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
  if (!turn.usage) return turn;
  const usage = deltaUsage(turn.usage, sessions.usageBaseline(convId));
  sessions.rememberUsage(convId, turn.usage);
  return { ...turn, usage };
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
