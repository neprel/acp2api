import { AgentError } from "./agent.js";
import { errorBody, makeLimiter, RequestError } from "./openai.js";
import { parseResponsesRequest, responseObject, ResponseStream } from "./responses.js";
import { newResponseId } from "./sessions.js";
import { readJsonBody } from "./http-ingress.js";
import { runTurnLifecycle } from "./turn-lifecycle.js";
import { endSse, endSseError, markResponsesStream, send, writeDone, writeResponseEvent } from "./sse.js";
import {
  benchServer,
  makeSink,
  retireDeadConversation,
  settleUsage,
  suspectedTextToolCall,
  timeoutError as makeTimeoutError,
  untilTurnOrToolCall,
  watchDeadTurn,
} from "./turn-runtime.js";

const timeoutError = (model, config) => makeTimeoutError(model, config, AgentError);

/** Normalizes and resolves a Responses request before continuation ownership. */
export function prepareResponsesRequest(body, { config, params, registry }) {
  const request = parseResponsesRequest(body);
  request.ignored = config.server.tools === "off" && request.toolsProvided && body.tools.length > 0
    ? [...new Set([...request.ignored, "tools"])].sort()
    : request.ignored;
  params.report(request.model, request.ignored);
  const agent = registry.get(request.model);
  if (!agent) {
    throw new RequestError(
      `model "${request.model}" not found; available: ${[...registry.keys()].join(", ")}`,
      404,
      "model_not_found",
    );
  }
  return { request, agent };
}

/** Claims and validates the only continuation point a Responses turn may use. */
export function claimResponsesContinuation(request, sessions, log = () => {}) {
  if (!request.previousResponseId) {
    return { conversation: null, convId: null, responseClaimId: null };
  }
  const conversation = sessions.claimResponse(request.previousResponseId);
  if (!conversation) {
    throw new RequestError(
      `previous_response_id ${request.previousResponseId} is unknown or its session has expired`,
      404,
      "not_found",
    );
  }
  const release = () => {
    if (conversation.claimId) sessions.releaseResponseClaim(conversation.convId, conversation.claimId);
  };
  if (conversation.agentName !== request.model) {
    release();
    throw new RequestError(
      `previous_response_id belongs to model "${conversation.agentName}", not "${request.model}"`,
      400,
      "invalid_request_error",
    );
  }
  if (conversation.continuation === "stale") {
    throw new RequestError(
      `previous_response_id ${request.previousResponseId} is not the latest response in its conversation`,
      409,
      "stale_previous_response",
    );
  }
  if (conversation.continuation === "busy") {
    throw new RequestError(
      `${request.model}: this conversation is already serving a turn`,
      409,
      "conversation_busy",
    );
  }
  if (conversation.instructions !== request.instructions) {
    release();
    throw new RequestError(
      "`instructions` cannot be changed, added, or removed while continuing a response; start a new conversation",
      400,
      "unsupported_parameter",
    );
  }
  // Instructions are a text preamble sent once when the ACP session opens. The
  // retained session already heard it, so continuation sends only the new input.
  request.blocks = request.inputBlocks;
  log("info", `${request.model}: claimed response continuation ${request.previousResponseId}`);
  return {
    conversation,
    convId: conversation.convId,
    responseClaimId: conversation.claimId ?? null,
  };
}

/** Rejects tool-output loss or partial resolution before the ACP turn can advance. */
export function validateResponsesToolOutputs(request, conversation) {
  if (request.toolResults.length === 0) return;
  if (!conversation?.pending) {
    throw new RequestError(
      "function_call_output requires a previous_response_id for a suspended tool turn",
      400,
      "invalid_request_error",
    );
  }
  if (request.inputBlocks.length > 0) {
    throw new RequestError(
      "function_call_output cannot be mixed with new message input while a tool turn is suspended",
      400,
      "invalid_request_error",
    );
  }
  const ids = request.toolResults.map((result) => result.id);
  const expected = new Set(conversation.pending.callIds ?? []);
  if (new Set(ids).size !== ids.length || ids.some((id) => !expected.has(id))) {
    throw new RequestError(
      `${request.model}: one or more function_call_output call_id values do not match this suspended turn`,
      400,
      "invalid_request_error",
    );
  }
}

export async function handleResponse(req, res, registry, config, log, params, sessions, tools, httpServer) {
  const body = await readJsonBody(req);

  const { request, agent } = prepareResponsesRequest(body, { config, params, registry });

  let { conversation, convId, responseClaimId } = claimResponsesContinuation(request, sessions, log);
  // A free continuation owns the turn it just claimed. A request carrying tool
  // results adopts the already-owned suspended turn and releases it if it settles.
  // A conflicting continuation merely observes another owner and must not release.
  let releasesConversation = Boolean(conversation && (responseClaimId || conversation.pending));
  let opened = false;
  let session = null;
  let turnAdvanced = false;
  let chainInvalidated = false;
  const invalidateAdvancedChain = async () => {
    if (!turnAdvanced || !convId || chainInvalidated) return;
    chainInvalidated = true;
    const invalidated = convId;
    convId = null;
    if (opened) {
      if (session?.dead) await sessions.retire(invalidated, "dead_session", registry);
      else await sessions.discard(invalidated, registry);
    } else {
      // This request advanced an already-stored chain. End its continuation state,
      // but keep the prior successful bodies available to GET as immutable history.
      await sessions.finishUnstored(invalidated, registry);
    }
  };
  const run = async (requestTurn) => {
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
    validateResponsesToolOutputs(request, conversation);
    if (serveTools && !request.store) {
      throw new RequestError(
        "`store: false` cannot be used with tools because a tool call must be retained for its result request",
        400,
        "store_required",
      );
    }

    const existingBench = conversation ? sessions.bench(convId) : null;
    if (existingBench && !request.store) {
      throw new RequestError(
        "`store: false` cannot continue a conversation with caller tools because a call may cross requests",
        400,
        "store_required",
      );
    }
    if (serveTools && conversation && !existingBench) {
      throw new RequestError(
        "tools cannot be added to a continued Responses conversation because its session was opened without " +
          "a tool bench; start a new conversation without previous_response_id",
        400,
        "invalid_request_error",
      );
    }

    // A turn of this conversation is suspended inside a tool call, and this request
    // carries its answer. Same shape as on chat completions -- the agent is still
    // inside the call it made, so nothing below (session, prompt, history) applies.
    if (conversation?.pending) {
      session = conversation.session;
      if (request.toolResults.length === 0) {
        throw new RequestError(
          `${request.model}: this conversation is waiting for a tool result; send the matching ` +
            `function_call_output, or start a new conversation without previous_response_id`,
          409,
          "tool_result_expected",
        );
      } else {
        const pending = conversation.pending;
        // Resolving a call advances the already-running ACP turn. From this point
        // the previous response no longer represents the live session state.
        turnAdvanced = true;
        const answered = request.toolResults.filter((r) => tools.resolve(pending.bench, r.id, r.text));
        if (answered.length !== request.toolResults.length) {
          throw new RequestError("a function_call_output could not be resolved", 409, "tool_result_expected");
        }
        requestTurn.abortPendingWith(pending.abort);
        log("info", `${request.model}: answered ${answered.length} tool call(s); the turn continues`);
        pending.seen = { text: "", reasoning: "" };
        return await settleResponseTurn({
          res, tools, sessions, registry, convId, pending, shape, id, stream: request.stream,
          log, model: request.model, sessionsRecord: request.store,
          clientGone: requestTurn.clientGone,
          timedOut: requestTurn.timedOut,
          timeout: () => timeoutError(request.model, config),
          requestSignal: requestTurn.controller.signal,
          invalidateOnDisconnect: invalidateAdvancedChain,
        });
      }
    }

    session = conversation?.session ?? null;
    // Parked: the conversation gave back its session while nobody was continuing
    // it, and kept the id. `previous_response_id` still resolves, so restore it
    // rather than answering the caller from a stranger.
    if (!session && conversation?.sessionId) {
      const resumeContext = conversation.resumeContext ?? {
        mcpServers: existingBench ? [benchServer(httpServer, existingBench)] : [],
      };
      session = await agent.resumeSession(conversation.sessionId, resumeContext);
      if (session) sessions.revive(convId, session);
      else {
        await sessions.retire(convId, "revive_failed", registry);
        convId = null;
        throw new RequestError(
          `previous_response_id ${request.previousResponseId} can no longer be resumed`,
          404,
          "not_found",
        );
      }
    }
    // A bench must exist before the session opens: `session/new` is the only
    // place an MCP server can be declared, and `session/resume` compares the list
    // it is given against the one the session was built with.
    let bench = existingBench;
    let openedBench = false;
    if (serveTools && !bench) {
      bench = tools.open(request.tools);
      openedBench = true;
      session = null;
      if (convId) {
        await sessions.discard(convId, registry);
        convId = null;
      }
    } else if (bench && request.toolsProvided && request.toolChoice !== "none") {
      tools.setTools(bench, request.tools);
    }
    if (bench) tools.setEnabled(bench, request.toolChoice !== "none");

    if (!session) {
      let admissionId = null;
      try {
        admissionId = await sessions.prepareOpen(registry);
        session = await agent.openSession({ mcpServers: bench ? [benchServer(httpServer, bench)] : [] });
      } catch (error) {
        if (admissionId) sessions.cancelOpen(admissionId);
        if (openedBench) tools.close(bench);
        throw error;
      }
      opened = true;
      convId = sessions.open(request.model, session, {
        bench,
        replayable: false,
        instructions: request.instructions,
        resumeContext: session.resumeContext ?? { mcpServers: bench ? [benchServer(httpServer, bench)] : [] },
        admissionId,
      });
      sessions.claim(convId);
      releasesConversation = true;
    }

    // `reasoning.effort` is re-applied per turn: on a continued conversation the
    // caller may raise it for one hard question and drop it again afterwards.
    const overrides = { reasoning: request.reasoning };

    let stream = null;
    const start = () => {
      if (stream) return stream;
      markResponsesStream(res);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      stream = new ResponseStream((event) => writeResponseEvent(res, event), {
        id,
        response: shape({ text: "", reasoning: "", stopReason: "end_turn", usage: null }),
      });
      stream.created();
      return stream;
    };

    if (bench) {
      const sink = makeSink();
      agent.preflightTurn(session, request.blocks, { signal: requestTurn.controller.signal, overrides });
      turnAdvanced = true;
      const running = agent.turn(session, request.blocks, {
        signal: requestTurn.controller.signal,
        limit,
        overrides,
        onEvent: (e) => sink.emit(e),
      });
      running.catch(() => {});
      const pending = {
        turn: running,
        session,
        sink,
        bench,
        seen: { text: "", reasoning: "" },
        abort: () => requestTurn.controller.abort(),
      };
      watchDeadTurn(pending, sessions, convId, registry);
      return await settleResponseTurn({
        res, tools, sessions, registry, convId, shape, id, stream: request.stream, log,
        model: request.model, sessionsRecord: request.store,
        clientGone: requestTurn.clientGone,
        timedOut: requestTurn.timedOut,
        timeout: () => timeoutError(request.model, config),
        invalidateOnDisconnect: invalidateAdvancedChain,
        pending,
      });
    }

    agent.preflightTurn(session, request.blocks, { signal: requestTurn.controller.signal, overrides });
    turnAdvanced = true;
    const turn = await agent.turn(session, request.blocks, {
      signal: requestTurn.controller.signal,
      limit,
      overrides,
      onEvent: (e) => {
        if (!request.stream || e.type === "tool_call") return;
        start().delta(e.type === "reasoning" ? "reasoning" : "message", e.delta);
      },
    });

    if (requestTurn.clientGone()) {
      await invalidateAdvancedChain();
      return res.end();
    }
    if (requestTurn.timedOut()) throw timeoutError(request.model, config);

    let response = shape(settleUsage(sessions, convId, turn));
    if (request.stream) response = start().finalize(response);
    const retired = await retireDeadConversation(sessions, convId, session, registry);
    // `store: false` means the caller will never continue from this id, so the
    // session it opened has no future -- keeping it would retain a live login.
    if (request.store && !retired) {
      await recordResponseOrFinish(sessions, convId, id, response, registry);
    } else if (!retired) {
      await sessions.finishUnstored(convId, registry);
      convId = null;
    }

    if (!request.stream) return send(res, 200, response);
    stream.completed(response);
    writeDone(res);
    return endSse(res);
  };
  const failed = async (e, requestTurn) => {
    await invalidateAdvancedChain();
    // A conversation that never produced a response is not a conversation. Leaving
    // it behind would retain a live login nobody can ever reach again.
    if (!turnAdvanced && (opened || session?.dead) && convId) {
      if (session?.dead) await sessions.retire(convId, "dead_session", registry);
      else await sessions.discard(convId, registry);
    }
    if (requestTurn.clientGone()) {
      log("warn", `${request.model}: client disconnected`);
      return res.end();
    }
    if (requestTurn.timedOut() && !(e instanceof AgentError && e.status === 429)) {
      log("warn", `${request.model}: timed out after ${config.server.requestTimeoutMs}ms`);
      if (!res.headersSent) return send(res, 504, errorBody(timeoutError(request.model, config).message, "timeout"));
      return endSseError(res, timeoutError(request.model, config).message, "timeout");
    }
    throw e;
  };
  const release = () => {
    if (!releasesConversation || !convId) return;
    if (responseClaimId) sessions.releaseResponseClaim(convId, responseClaimId);
    else if (!sessions.isPending(convId)) sessions.setBusy(convId, false);
  };
  return runTurnLifecycle({ req, res, config, run, failed, release });
}
async function settleResponseTurn(o) {
  const { pending, tools, sessions, convId, shape, res } = o;
  pending.attached = true;

  // Written through, for the same reason as on chat completions: a turn that can
  // stop for a tool is still a turn someone is watching, and collecting its trace
  // to deliver at the end removes the live view from every caller that sends tools.
  let stream = null;
  const open = (body) => {
    if (stream) return stream;
    markResponsesStream(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    stream = new ResponseStream((event) => writeResponseEvent(res, event), { id: o.id, response: body });
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

  const outcome = await untilTurnOrToolCall(pending, tools, o.requestSignal);
  if (outcome.error) {
    sessions.setPending(convId, null);
    await retireDeadConversation(sessions, convId, pending.session, o.registry);
    throw outcome.error;
  }

  if (o.clientGone()) {
    pending.sink.detach();
    pending.attached = false;
    sessions.setPending(convId, null);
    await o.invalidateOnDisconnect?.();
    return res.end();
  }
  if (o.timedOut()) {
    pending.sink.detach();
    pending.attached = false;
    sessions.setPending(convId, null);
    throw o.timeout();
  }

  const streamed = (body) => {
    if (!o.stream) return send(res, 200, body);
    open(body).completed(body);
    writeDone(res);
    return endSse(res);
  };

  if (outcome.calls?.length) {
    pending.callIds = outcome.calls.map((call) => call.id);
    tools.reported(pending.bench, outcome.calls.map((c) => c.id));
    pending.sink.detach();
    pending.attached = false;
    sessions.setPending(convId, pending);
    o.log("info", `${o.model}: turn is waiting on ${outcome.calls.length} client tool call(s)`);
    let asking = shape({
      text: pending.seen.text,
      reasoning: pending.seen.reasoning,
      stopReason: "end_turn",
      usage: null,
      calls: outcome.calls,
    });
    if (o.stream) asking = open(asking).finalize(asking);
    // RECORDED, even though the turn is not finished. This id is what the caller
    // puts in `previous_response_id` to send the result back, and without it there
    // is no way to reach the turn that is waiting for it -- a 404 instead of a
    // continuation.
    if (o.sessionsRecord) await recordResponseOrFinish(sessions, convId, o.id, asking, o.registry);
    return streamed(asking);
  }

  sessions.setPending(convId, null);
  const turn = { ...outcome.turn, text: pending.seen.text, reasoning: pending.seen.reasoning };
  const suspected = suspectedTextToolCall(tools, pending.bench, turn.text, o.model, o.log);
  let body = shape({ ...settleUsage(sessions, convId, turn), suspectedTextToolCall: suspected });
  if (o.stream) body = open(body).finalize(body);
  const retired = await retireDeadConversation(sessions, convId, pending.session, o.registry);
  if (o.sessionsRecord && !retired) await recordResponseOrFinish(sessions, convId, o.id, body, o.registry);
  return streamed(body);
}

/** A failed storage commit ends the advanced chain so its old tip cannot lie. */
async function recordResponseOrFinish(sessions, convId, responseId, body, registry) {
  try {
    sessions.record(convId, responseId, body);
  } catch (error) {
    await sessions.finishUnstored(convId, registry);
    throw error;
  }
}
