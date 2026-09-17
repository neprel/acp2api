import { RequestError } from "./openai.js";

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=(?:utf-8|utf8))?$/i;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError("request body too large", 413, "payload_too_large"));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch (error) {
        reject(new RequestError(`invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

const normalizeHost = (value) => {
  try {
    return new URL(`http://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
};

const listenerHosts = (req, configuredHost) => {
  const port = req.socket.localPort;
  const configured = String(configuredHost ?? "").toLowerCase();
  const hosts = new Set();
  const add = (name) => {
    if (!name) return;
    hosts.add(normalizeHost(name.includes(":") && !name.startsWith("[") ? `[${name}]:${port}` : `${name}:${port}`));
  };
  add(req.socket.localAddress);
  add(configured);
  // Loopback listeners are routinely reached through either spelling. This does
  // not widen a network listener: both names still resolve back to this process.
  if (["127.0.0.1", "::1", "localhost"].includes(configured)) {
    add("127.0.0.1");
    add("::1");
    add("localhost");
  }
  hosts.delete(null);
  return hosts;
};

/** Reject browser and DNS-rebinding ingress before a route can start an agent. */
export function validateHttpIngress(req, config, { inference = false } = {}) {
  const host = normalizeHost(req.headers.host);
  const explicit = Array.isArray(config.allowedHosts)
    ? new Set(config.allowedHosts.map(normalizeHost).filter(Boolean))
    : null;
  if (!host || !(explicit?.has(host) || listenerHosts(req, config.host).has(host))) {
    throw new RequestError("request Host is not allowed", 400, "invalid_host");
  }

  const origin = req.headers.origin;
  if (origin != null) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host.toLowerCase() === host;
    } catch {
      // Opaque `Origin: null` is not same-origin. It is accepted only by an
      // explicit wildcard (or an exact configured string, if config permits it).
    }
    const allowed = sameOrigin || config.cors === true || (typeof config.cors === "string" && origin === config.cors);
    if (!allowed) throw new RequestError("request Origin is not allowed", 403, "invalid_origin");
  }

  if (inference && req.method === "POST" && !JSON_MEDIA_TYPE.test(String(req.headers["content-type"] ?? ""))) {
    throw new RequestError("Content-Type must be application/json", 415, "unsupported_media_type");
  }
}
