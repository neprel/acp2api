import { createServer as createHttpServer } from "node:http";
import { Agent } from "./agent.js";
import { ParamReporter } from "./params.js";
import { errorBody, RequestError } from "./openai.js";
import { SessionStore } from "./sessions.js";
import { ToolBridge } from "./mcp.js";
import { Metrics } from "./metrics.js";
import { validateHttpIngress } from "./http-ingress.js";
import { endSseError, send } from "./sse.js";
import { handleCompletion } from "./chat-handler.js";
import { handleResponse } from "./responses-handler.js";

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
    maxConversations: config.server.maxConversations,
    maxResponses: config.server.maxResponses,
    maxResponseBytes: config.server.maxResponseBytes,
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
  sessions.onPendingClear = (convId) => tools.releaseConversation(convId);
  sessions.startCleanup(registry);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    applyCors(req, res, config.server);
    try {
      const inference = req.method === "POST" && (
        url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions" ||
        url.pathname === "/v1/responses" || url.pathname === "/responses"
      );
      validateHttpIngress(req, config.server, { inference });
      if (config.server.cors && req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
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
      else endSseError(res, e.message, e.code ?? "internal_error");
    }
  });

  // Handed to the caller so the process can start the metrics listener and so a
  // test can read the registry without a socket.
  server.metrics = metrics;

  let shutdown = null;
  server.on("close", () => {
    shutdown ??= (async () => {
      // Retained sessions first: each is a live login, and closing the agent out
      // from under one leaves the CLI to be killed rather than told.
      await sessions.closeAll(registry).catch(() => {});
      await Promise.all([...registry.values()].map((agent) => Promise.resolve(agent.close?.()).catch(() => {})));
    })();
  });
  // EventEmitter does not await async listeners. The CLI waits on this explicit
  // promise before exiting, so SIGKILL escalation has time to run.
  server.whenClosed = () => shutdown ?? Promise.resolve();
  return server;
}

function applyCors(req, res, config) {
  if (!config.cors) return;
  res.setHeader("access-control-allow-origin", config.cors === true ? "*" : config.cors);
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  const headers = ["content-type", "authorization", config.conversationHeader, config.injectHeader].filter(Boolean);
  res.setHeader("access-control-allow-headers", [...new Set(headers)].join(", "));
  if (config.cors !== true) res.setHeader("vary", "Origin");
}
