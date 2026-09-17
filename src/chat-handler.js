import { AgentError } from "./agent.js";
import {
  chunk,
  completion,
  errorBody,
  makeLimiter,
  newCompletionId,
  parseChatRequest,
  RequestError,
  toPromptBlocks,
  toolCallCompletion,
  toolCallDeltas,
  usageChunk,
} from "./openai.js";
import { commonPrefix, conversationKey, fingerprint } from "./sessions.js";
import { runTurnLifecycle } from "./turn-lifecycle.js";
import { endSse, endSseError, send, write, writeDone } from "./sse.js";
import {
  suspectedTextToolCall,
  benchServer,
  makeSink,
  untilTurnOrToolCall,
  remember,
  retireDeadConversation,
  watchDeadTurn,
  settleUsage,
  finishOf,
  timeoutError,
} from "./turn-runtime.js";

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

/** Normalizes and resolves a Chat request before any conversation is touched. */
export function prepareChatRequest(body, { config, params, registry }) {
  const request = parseChatRequest(body);
  const serveTools = config.server.tools === "mcp" && request.tools.length > 0;
  const reported = config.server.tools === "off" && request.toolsProvided && body.tools.length > 0
    ? [...new Set([...request.ignored, "tools"])].sort()
    : serveTools ? request.ignored.filter((key) => key !== "tools") : request.ignored;
  params.report(request.model, reported);
  const agent = registry.get(request.model);
  if (!agent) {
    throw new RequestError(
      `model "${request.model}" not found; available: ${[...registry.keys()].join(", ")}`,
      404,
      "model_not_found",
    );
  }
  return { ...request, agent, reported, serveTools };
}

export async function handleCompletion(req, res, registry, config, log, params, sessions, tools, httpServer) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    throw e instanceof RequestError ? e : new RequestError(`invalid JSON body: ${e.message}`);
  }

  const prepared = prepareChatRequest(body, { config, params, registry });
  const {
    model, stream, includeUsage, maxTokens, stop, reasoning, toolChoice,
    toolsProvided, tools: declared, toolResults, agent, reported, serveTools,
  } = prepared;
  const limit = makeLimiter({ maxTokens, stop });

  const { systemId, turns, prefix } = conversationKey(body.messages);
  const callerKey = config.server.conversationHeader
    ? String(req.headers[config.server.conversationHeader] ?? "").trim().slice(0, 512)
    : "";
  const injectOnly = Boolean(
    config.server.injectHeader && String(req.headers[config.server.injectHeader] ?? "").trim(),
  );
  const idConversations = new Map();
  for (const result of toolResults) {
    const indexed = tools.conversation(result.id);
    if (!indexed || idConversations.has(indexed)) continue;
    const pending = sessions.peekPending(indexed);
    if (pending) idConversations.set(indexed, { match: pending, ids: [result.id] });
    else tools.releaseConversation(indexed);
  }
  for (const result of toolResults) {
    const indexed = tools.conversation(result.id);
    const found = indexed && idConversations.get(indexed);
    if (found && !found.ids.includes(result.id)) found.ids.push(result.id);
  }
  const idCandidates = [...idConversations.values()];
  const idCandidate = idCandidates.length === 1 ? idCandidates[0] : null;
  const idAgent = idCandidate ? sessions.agentOf(idCandidate.match.convId) : null;
  const idMatch = idCandidate && idAgent === model ? idCandidate.match : null;
  let match;
  if (idMatch) {
    const contextual = (callerKey && sessions.peekKey(model, callerKey, { whenBusy: config.server.busy })) ||
      sessions.peekPrefix(model, systemId, prefix);
    if (contextual && contextual.convId !== idMatch.convId) {
      log(
        "warn",
        `${model}: tool call id(s) ${idCandidate.ids.join(", ")} override a different ` +
          `${callerKey ? `conversation header [${callerKey}]` : "prefix conversation"}`,
      );
    }
    match = idMatch;
  } else if (idCandidates.length === 0) {
    match = !config.server.continuity
      ? null
      : injectOnly
        ? (callerKey && sessions.peekKey(model, callerKey, { whenBusy: config.server.busy })) ||
          sessions.peekPrefix(model, systemId, prefix)
        : (callerKey && sessions.matchKey(model, callerKey, { whenBusy: config.server.busy })) ||
          sessions.matchPrefix(model, systemId, prefix);
  } else {
    match = null;
  }

  const timeout = () => timeoutError(model, config, AgentError);
  let convId = null;
  let keyed = false;
  let opened = false;
  let session = null;
  let replay = null;
  const run = async (requestTurn) => {
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const meta = { id, model, created };

    if (injectOnly && (idCandidates.length > 0 || match?.pending)) {
      return send(res, 409, errorBody(`${model}: no turn is running for this conversation to join`, "no_running_turn"));
    }
    if (idCandidates.length > 1) {
      throw new RequestError(
        `${model}: tool results match more than one suspended turn: ` +
          idCandidates.flatMap((candidate) => candidate.ids).join(", "),
        409,
        "ambiguous_tool_results",
      );
    }
    if (idCandidate && idAgent !== model) {
      throw new RequestError(
        `tool_call_id ${idCandidate.ids.join(", ")} belongs to model "${idAgent}", not "${model}"`,
        400,
        "invalid_request_error",
      );
    }

    if (match?.pending) {
      session = match.session;
      if (toolResults.length === 0) {
        log("warn", `${model}: abandoning a turn suspended in a tool call -- the caller sent a new message instead of results${callerKey ? ` [${callerKey}]` : ""}`);
        await sessions.retire(match.convId, "abandoned_tool_turn", registry);
        match = null;
      } else {
        requestTurn.abortPendingWith(match.pending.abort);
        return await resumeToolCall({
          req, res, match, sessions, tools, config, log, model, meta, stream,
          includeUsage, toolResults, prefix, ignored: reported,
          clientGone: requestTurn.clientGone,
          timedOut: requestTurn.timedOut,
          timeout,
          requestSignal: requestTurn.controller.signal,
          keepPendingOnDisconnect: true,
          registry,
        });
      }
    }

    if (toolResults.length > 0 && idCandidates.length === 0) {
      log("warn", `${model}: tool result id(s) match no live turn: ${toolResults.map((result) => result.id).join(", ")}`);
    }
    if (match && toolResults.length > 0) {
      log("warn", `${model}: discarding a settled tool turn before accepting late results${callerKey ? ` [${callerKey}]` : ""}`);
      await sessions.retire(match.convId, "late_results", registry);
      match = null;
    }

    if (injectOnly && !match?.busy) {
      return send(res, 409, errorBody(`${model}: no turn is running for this conversation to join`, "no_running_turn"));
    }
    if (match?.busy) {
      if (!match.queue) {
        return send(res, 409, errorBody(`${model}: this conversation is already serving a turn`, "conversation_busy"));
      }
      const queued = await agent.inject(match.session, toPromptBlocks(turns.slice(-1)));
      log("info", `${model}: ${queued ? "injected into" : "could not join"} the running turn [${callerKey}]`);
      if (!queued && injectOnly) {
        return send(res, 409, errorBody(`${model}: this agent cannot take a prompt mid-turn`, "no_running_turn"));
      }
      if (!stream) {
        return send(res, 200, completion({ ...meta, text: "", stopReason: "end_turn", usage: null }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      write(res, chunk({ ...meta, delta: { role: "assistant", content: "" } }));
      write(res, chunk({ ...meta, delta: {}, finishReason: "stop" }));
      writeDone(res);
      return endSse(res);
    }

    convId = match?.convId ?? null;
    session = match?.session ?? null;
    keyed = Boolean(match?.prefix);
    const heard = match?.prefix ? commonPrefix(match.prefix, prefix) : (match?.matched ?? 0);
    const fresh = turns.slice(heard);
    if (!session && match?.sessionId) {
      log("info", `${model}: resuming ${match.sessionId}${callerKey ? ` [${callerKey}]` : ""}`);
      const resumeMcp = match.bench ? [benchServer(httpServer, match.bench)] : [];
      session = await agent.resumeSession(match.sessionId, match.resumeContext ?? { mcpServers: resumeMcp });
      if (session) {
        sessions.revive(convId, session);
        log("info", `${model}: resumed ${match.sessionId}${callerKey ? ` [${callerKey}]` : ""}`);
      } else {
        await sessions.retire(convId, "revive_failed", registry);
        convId = null;
      }
    }

    let bench = match?.bench ?? null;
    let openedBench = false;
    if (serveTools && !bench) {
      bench = tools.open(declared);
      openedBench = true;
      session = null;
      if (convId) {
        await sessions.discard(convId, registry);
        convId = null;
      }
    } else if (bench && toolsProvided && toolChoice !== "none") {
      tools.setTools(bench, declared);
    }
    if (bench) tools.setEnabled(bench, toolChoice !== "none");
    const benchServers = bench ? [benchServer(httpServer, bench)] : [];

    opened = !session;
    const blocks = toPromptBlocks(opened ? body.messages : fresh.length > 0 ? fresh : turns.slice(-1));
    if (opened) {
      let admissionId = null;
      try {
        admissionId = await sessions.prepareOpen(registry);
        session = await agent.openSession({ mcpServers: benchServers });
      } catch (error) {
        if (admissionId) sessions.cancelOpen(admissionId);
        if (openedBench) tools.close(bench);
        throw error;
      }
      convId = sessions.open(model, session, {
        systemId,
        prefix,
        key: callerKey || null,
        bench,
        resumeContext: session.resumeContext ?? { mcpServers: benchServers },
        admissionId,
      });
      sessions.claim(convId);
      replay = sessions.consumeRetirement(model, { key: callerKey || null, systemId, prefix });
      log(
        "info",
        `${model}: new session for ${prefix.length} message(s)${callerKey ? ` [${callerKey}]` : ""}` +
          (bench ? ` with ${declared.length} caller tool(s)` : ""),
      );
    } else {
      const how = keyed ? `keyed [${callerKey}]` : "by prefix";
      log("info", `${model}: continuing session ${how}, ${fresh.length} new of ${prefix.length} message(s)`);
    }

    if (bench) {
      return await runToolTurn({
        res, agent, session, blocks, controller: requestTurn.controller, limit, sessions, tools, registry, convId,
        bench, prefix, meta, stream, includeUsage, log, model, ignored: reported,
        overrides: { reasoning }, replay,
        clientGone: requestTurn.clientGone,
        timedOut: requestTurn.timedOut,
        timeout,
      });
    }

    if (!stream) {
      const turn = await agent.turn(session, blocks, {
        signal: requestTurn.controller.signal,
        limit,
        overrides: { reasoning },
      });
      if (requestTurn.clientGone()) return res.end();
      if (requestTurn.timedOut()) throw timeout();
      const settled = settleUsage(sessions, convId, turn);
      const retired = await retireDeadConversation(sessions, convId, session, registry);
      if (!retired) remember(sessions, convId, prefix, turn.text);
      return send(res, 200, completion({ ...meta, ...settled, ignored: reported, session: replay }));
    }

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
      signal: requestTurn.controller.signal,
      limit,
      overrides: { reasoning },
      onEvent: (e) => {
        if (e.type === "tool_call") return;
        start();
        const delta = e.type === "reasoning" ? { reasoning_content: e.delta } : { content: e.delta };
        write(res, chunk({ ...meta, delta }));
      },
    });
    if (requestTurn.clientGone()) return res.end();
    if (requestTurn.timedOut() && !started) throw timeout();
    const settled = settleUsage(sessions, convId, turn);
    const retired = await retireDeadConversation(sessions, convId, session, registry);
    if (!retired) remember(sessions, convId, prefix, turn.text);
    start();
    write(res, chunk({
      ...meta,
      delta: {},
      finishReason: requestTurn.timedOut() ? "length" : finishOf(turn.stopReason),
      stopReason: turn.stopReason,
      ignored: reported,
      context: settled.context,
      cost: settled.cost,
      session: replay,
    }));
    if (includeUsage && settled.usage) write(res, usageChunk({ ...meta, usage: settled.usage }));
    writeDone(res);
    endSse(res);
  };

  const failed = async (e, requestTurn) => {
    const abandoned = requestTurn.clientGone() || requestTurn.timedOut();
    if (convId && (session?.dead || !(keyed && !opened && abandoned))) {
      if (session?.dead) await sessions.retire(convId, "dead_session", registry);
      else await sessions.discard(convId, registry);
      convId = null;
    }
    if (requestTurn.clientGone()) {
      log("warn", `${model}: client disconnected`);
      return res.end();
    }
    if (requestTurn.timedOut() && !(e instanceof AgentError && e.status === 429)) {
      log("warn", `${model}: timed out after ${config.server.requestTimeoutMs}ms`);
      if (!res.headersSent) return send(res, 504, errorBody(timeout().message, "timeout"));
      return endSseError(res, timeout().message, "timeout");
    }
    throw e;
  };
  const release = () => {
    if (convId && !sessions.isPending(convId)) sessions.setBusy(convId, false);
  };
  return runTurnLifecycle({ req, res, config, run, failed, release });
}

async function runToolTurn(o) {
  const sink = makeSink();
  const seen = { text: "", reasoning: "" };
  const turn = o.agent.turn(o.session, o.blocks, {
    signal: o.controller.signal,
    limit: o.limit,
    overrides: o.overrides,
    onEvent: (event) => sink.emit(event),
  });
  turn.catch(() => {});
  const pending = {
    turn,
    session: o.session,
    sink,
    bench: o.bench,
    seen,
    prefix: o.prefix,
    abort: () => o.controller.abort(),
  };
  watchDeadTurn(pending, o.sessions, o.convId, o.registry);
  return await settleToolTurn({ ...o, pending });
}

async function settleToolTurn(o) {
  const { pending, tools, sessions, convId, meta, res } = o;
  pending.attached = true;
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
    else return;
    if (!o.stream) return;
    start();
    write(res, chunk({
      ...meta,
      delta: event.type === "reasoning" ? { reasoning_content: event.delta } : { content: event.delta },
    }));
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
    sessions.setPending(convId, o.keepPendingOnDisconnect ? pending : null);
    return res.end();
  }
  if (o.timedOut()) {
    pending.sink.detach();
    pending.attached = false;
    sessions.setPending(convId, null);
    throw o.timeout();
  }

  if (outcome.calls?.length) {
    pending.callIds = outcome.calls.map((call) => call.id);
    tools.reported(pending.bench, outcome.calls.map((c) => c.id), convId);
    pending.sink.detach();
    pending.attached = false;
    sessions.setPending(convId, pending);
    o.log("info", `${o.model}: turn is waiting on ${outcome.calls.length} client tool call(s)`);
    const body = toolCallCompletion({
      ...meta,
      calls: outcome.calls,
      text: pending.seen.text,
      reasoning: pending.seen.reasoning,
      ignored: o.ignored,
      session: o.replay,
    });
    pending.prefix = [...pending.prefix, fingerprint(body.choices[0].message)];
    sessions.extendPrefix(convId, pending.prefix);
    if (!o.stream) return send(res, 200, body);
    start();
    write(res, chunk({ ...meta, delta: { tool_calls: toolCallDeltas(outcome.calls) } }));
    write(res, chunk({
      ...meta,
      delta: {},
      finishReason: "tool_calls",
      ignored: o.ignored,
      session: o.replay,
    }));
    writeDone(res);
    return endSse(res);
  }

  sessions.setPending(convId, null);
  const turn = { ...outcome.turn, text: pending.seen.text, reasoning: pending.seen.reasoning };
  const settled = settleUsage(sessions, convId, turn);
  const suspected = suspectedTextToolCall(tools, pending.bench, turn.text, o.model, o.log);
  const retired = await retireDeadConversation(sessions, convId, pending.session, o.registry);
  if (!retired) remember(sessions, convId, pending.prefix, turn.text);
  if (!o.stream) {
    return send(res, 200, completion({
      ...meta,
      ...settled,
      ignored: o.ignored,
      suspectedTextToolCall: suspected,
      session: o.replay,
    }));
  }
  start();
  write(res, chunk({
    ...meta,
    delta: {},
    finishReason: finishOf(turn.stopReason),
    stopReason: turn.stopReason,
    ignored: o.ignored,
    suspectedTextToolCall: suspected,
    context: settled.context,
    cost: settled.cost,
    session: o.replay,
  }));
  if (o.includeUsage && settled.usage) write(res, usageChunk({ ...meta, usage: settled.usage }));
  writeDone(res);
  return endSse(res);
}

async function resumeToolCall(o) {
  const { match, sessions } = o;
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
    throw new RequestError(
      `${o.model}: this conversation is waiting for the result of a tool call; none of the tool messages sent match it`,
      409,
      "tool_result_expected",
    );
  }
  o.log("info", `${o.model}: answered ${answered.length} tool call(s); the turn continues`);
  pending.prefix = o.prefix;
  sessions.extendPrefix(match.convId, pending.prefix);
  pending.seen = { text: "", reasoning: "" };
  return await settleToolTurn({ ...o, pending, convId: match.convId, bench: pending.bench });
}
