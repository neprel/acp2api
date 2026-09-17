/**
 * Live ACP sessions behind the Responses API.
 *
 * This is what makes `previous_response_id` mean something. Chat completions are
 * stateless and must resend the whole history every time, which the agent then has
 * to read as one flattened transcript. A retained ACP session already holds the
 * conversation, so a continued turn sends **only the new input** -- less to send,
 * and the agent's own memory of the turn rather than our rendering of it.
 *
 * The unit of ACP retention is a CONVERSATION, while response bodies are retained
 * independently. A chain shares one ACP session, but only its latest stored response
 * may continue it: an older retained id is readable but stale, never a branch point.
 *
 * Every retained session is resident context in an agent process, so nothing here
 * may leak: parking and forgetting both close the ACP session, and so does shutdown.
 */

import { createHash } from "node:crypto";

/**
 * Fingerprints one OpenAI message.
 *
 * Covers exactly the fields that make a turn what it is. `content` alone is not
 * enough: an assistant turn that only called tools has `content: null`, and two
 * different tool results can share a `tool_call_id` across branches.
 */
const digest = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 22);

const freezeJson = (serialized) => {
  const value = JSON.parse(serialized);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(value);
};

const canonicalPart = (part) => {
  if (part?.type === "text") return { type: "text", text: part.text ?? "" };
  if (part?.type === "image_url") return { type: "image_url", url: part.image_url?.url ?? "" };
  if (part?.type === "file" || part?.type === "input_file") {
    const file = part.file ?? part;
    return {
      type: part.type,
      file_id: file.file_id ?? null,
      file_data: file.file_data ?? null,
      filename: file.filename ?? null,
    };
  }
  return { type: part?.type ?? null };
};

const canonicalContent = (content) => {
  if (!Array.isArray(content)) return content ?? null;
  if (content.length === 1 && content[0]?.type === "text") return content[0].text ?? "";
  return content.map(canonicalPart);
};

/** The stable semantic fields used anywhere messages are compared. */
export const canonicalMessage = (m) => ({
  role: m?.role ?? null,
  content: canonicalContent(m?.content),
  // `index` exists only on streamed tool-call deltas so SDKs can accumulate them;
  // it does not change which call was made. A client may resend either its final
  // accumulated message or the deltas it assembled itself, and both are the same
  // conversation prefix.
  tool_calls: m?.tool_calls?.map((call) => ({
    id: call?.id ?? null,
    type: call?.type ?? null,
    function: {
      name: call?.function?.name ?? null,
      arguments: call?.function?.arguments ?? null,
    },
  })) ?? null,
  tool_call_id: m?.tool_call_id ?? null,
  name: m?.name ?? null,
});

export const fingerprint = (message) => digest(canonicalMessage(message));

/**
 * Splits messages into the standing preamble and the conversation.
 *
 * System and developer messages are session IDENTITY, not turns: they are sent once
 * when the session opens. The conversation is what grows, and what a later request
 * can extend.
 */
export function conversationKey(messages) {
  const system = [];
  const turns = [];
  for (const m of messages ?? []) {
    (m?.role === "system" || m?.role === "developer" ? system : turns).push(m);
  }
  return { systemId: digest(system.map(fingerprint)), turns, prefix: turns.map(fingerprint) };
}

let counter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const newResponseId = () => nextId("resp");

export class SessionCapacityError extends Error {
  constructor(message = "conversation storage is full") {
    super(message);
    this.name = "SessionCapacityError";
    this.status = 503;
    this.code = "session_capacity";
  }
}

export class ResponseStorageError extends Error {
  constructor(message = "response cannot be stored within the configured limits") {
    super(message);
    this.name = "ResponseStorageError";
    this.status = 507;
    this.code = "response_storage_full";
  }
}

const RETIREMENT_REASONS = {
  context_fill: "context full",
  forgotten: "forgotten",
  revive_failed: "revive failed",
  dead_session: "dead session",
  abandoned_tool_turn: "abandoned tool turn",
  late_results: "late tool results",
};

/**
 * Length of the longest common prefix of two fingerprint lists -- how much of an
 * incoming history a session has already heard.
 *
 * Prefix matching produces this as a side effect of finding the session. Key
 * matching does not, and still needs it to decide what is new, so it lives here
 * rather than inside the search.
 */
export const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

export class SessionStore {
  #conversations = new Map(); // convId -> {agentName, session, responses:Set, lastUsed}
  #responses = new Map(); // responseId -> {convId, response}
  #keys = new Map(); // `${agentName} ${callerKey}` -> convId
  #tombstones = []; // bounded retirement attribution for a later fresh Chat turn
  #responseBytes = 0;
  #cleanupTimer = null;
  #cleanupPromise = null;
  #closed = false;
  #admissions = new Set();
  #admissionTail = Promise.resolve();

  constructor({
    max = 100,
    ttlMs = 3_600_000,
    forgetTtlMs = 86_400_000,
    maxContextFill = 0,
    now = () => Date.now(),
    log = () => {},
    onClose = () => {},
    onPendingClear = () => {},
    tombstoneMax = 1_000,
    maxConversations = 1_000,
    maxResponses = 1_000,
    maxResponseBytes = 64 * 1024 * 1024,
    // Optional. Held here rather than threaded through five call sites because this
    // store already owns the per-conversation baselines and the agent name, which
    // are exactly what a per-turn metric is made of. Null when metrics are off, and
    // every call site reaches it as `sessions.metrics?.`.
    metrics = null,
  } = {}) {
    this.metrics = metrics;
    // Called with a conversation record as it is dropped, so whatever else was
    // hanging off it -- a tool bench holding a call open -- goes with it. Parking
    // does NOT fire this: a parked conversation is coming back.
    this.onClose = onClose;
    this.onPendingClear = onPendingClear;
    this.max = max;
    this.ttlMs = ttlMs;
    // When a conversation stops being a conversation at all. `ttlMs` now only
    // decides when it gives back its resident session; this decides when the id is
    // dropped and the next message genuinely starts over.
    this.forgetTtlMs = Math.max(forgetTtlMs, ttlMs);
    // How full a session's context window may get before it stops being offered to
    // the next request. 0 disables the check entirely. See `#full`.
    this.maxContextFill = maxContextFill;
    this.tombstoneMax = tombstoneMax;
    this.maxConversations = maxConversations;
    this.maxResponses = maxResponses;
    this.maxResponseBytes = maxResponseBytes;
    this.now = now;
    this.log = log;
  }

  /**
   * Whether a conversation has filled enough of its context window to be retired.
   *
   * A TTL bounds how long a session sits idle; it says nothing about how large it
   * has grown. The session this store works hardest to keep -- one continued every
   * few minutes for a week -- is exactly the one that walks into the agent's own
   * compaction (a model call out of the same subscription) and then into a context
   * window it cannot recover from, which no retry cures. So retirement is decided
   * on how full a session is, and expiry on how long since anyone spoke; they are
   * different questions and neither substitutes for the other.
   *
   * Silence is not evidence of room: an agent that never reports `usage_update`
   * leaves `fill` null and keeps being offered. Guessing would retire healthy
   * sessions on every agent that does not implement the update.
   */
  #full(conv) {
    return this.maxContextFill > 0 && conv.fill != null && conv.fill >= this.maxContextFill;
  }

  #releaseSettledPending(convId, pending) {
    const conv = this.#conversations.get(convId);
    if (!conv || conv.pending !== pending || !pending.settled || pending.attached) return;
    this.#clearPending(convId, conv);
    conv.busy = false;
    conv.owner = null;
    conv.lastUsed = this.now();
    const calls = pending.callIds?.length ? `; waiting for tool_call_id ${pending.callIds.join(", ")}` : "";
    this.log("info", `session ${convId} (${conv.agentName}) released: suspended turn settled unattended${calls}`);
  }

  #clearPending(convId, conv) {
    const pending = conv.pending;
    if (!pending) return;
    conv.pending = null;
    try {
      this.onPendingClear(convId, conv, pending);
    } catch {
      /* a cleanup hook must not stop the pending turn from being released */
    }
  }

  #reportLive(agentName) {
    if (!this.metrics) return;
    let live = 0;
    for (const conv of this.#conversations.values()) {
      if (conv.agentName === agentName && conv.session) live += 1;
    }
    this.metrics.sessions(agentName, live);
  }

  get size() {
    return this.#conversations.size;
  }

  get responseCount() {
    return this.#responses.size;
  }

  get responseBytes() {
    return this.#responseBytes;
  }

  #expired(conv) {
    return conv.lastUsed + this.forgetTtlMs <= this.now();
  }

  /** Starts a conversation around a freshly opened session. Returns its id. */
  open(agentName, session, {
    systemId = null,
    prefix = [],
    key = null,
    bench = null,
    replayable = true,
    instructions = null,
    resumeContext = null,
    admissionId = null,
  } = {}) {
    if (this.#closed) throw new SessionCapacityError("session store is closed");
    if (admissionId) {
      if (!this.#admissions.delete(admissionId)) {
        throw new SessionCapacityError("conversation admission is missing or has already been consumed");
      }
    } else if (this.#conversations.size + this.#admissions.size >= this.maxConversations) {
      throw new SessionCapacityError(
        `conversation storage is full (${this.maxConversations}); run cleanup before opening another conversation`,
      );
    }
    const convId = nextId("conv");
    this.#conversations.set(convId, {
      agentName,
      session,
      // Kept beside the live handle, because a PARKED conversation has only this:
      // the agent-side session has been closed to free its resources, and the id is
      // what `session/resume` restores it from. See `park`.
      sessionId: session?.id ?? null,
      responses: new Set(),
      lastUsed: this.now(),
      // Continuity state: what this session has already been told.
      systemId,
      prefix: [...prefix],
      busy: false,
      key,
      // The session usage totals already reported. ACP counters are cumulative
      // across the session, so a turn's own cost is the difference against this.
      usage: null,
      // Fraction of the context window in use, from `usage_update`. null until the
      // agent says -- and not every agent does.
      fill: null,
      // The token naming this conversation's tool bench, when its caller sent
      // `tools`. It outlives parking, because the bench is addressed by URL and a
      // resumed session reconnects to the same one.
      bench,
      // A turn that stopped INSIDE a tool call and is waiting for the caller to
      // answer it. The conversation stays busy while this is set, and the next
      // request carrying results picks the same turn up rather than starting one.
      pending: null,
      // Responses has a proxy-proof previous_response_id and reports retirement as
      // 404. Only Chat resends enough identity to attribute a later fresh replay.
      replayable,
      // Responses continuation identity. `instructions` is deliberately allowed
      // to be null: omission does not inherit a previous value.
      instructions,
      // The exact caller-owned arguments used to open the ACP session. The server
      // passes these unchanged to resumeSession; Agent adds its configured cwd and
      // MCP baseline when it builds the complete resume fingerprint.
      resumeContext,
      latestResponseId: null,
      owner: null,
    });
    // A key is installed only for a new conversation. Once installed, a request
    // that finds it busy is refused or steered; it never opens another conversation
    // and rebinds the key away from the turn that already owns that identity.
    if (key) this.#keys.set(`${agentName} ${key}`, convId);
    this.#reportLive(agentName);
    return convId;
  }

  /**
   * Finds the live session a caller NAMED, regardless of what it sent.
   *
   * The stronger form of continuity, and the only one available to a caller that
   * keeps the transcript on its own side: it hands back one rolled-up turn per
   * request, so there is no growing prefix to match and `matchPrefix` can never
   * succeed. A stable key from the caller says "this is the same conversation"
   * outright, and keeps saying it through an edited system prompt, a trimmed
   * history or a compacted transcript.
   *
   * `systemId` is deliberately NOT consulted. Under prefix matching the preamble
   * is the only evidence of identity available, so a change to it must fork; here
   * the caller has asserted identity directly, and a caller that rewrites its own
   * preamble mid-conversation means it.
   */
  matchKey(agentName, key, { whenBusy = "fork" } = {}) {
    return this.#matchKey(agentName, key, whenBusy, true);
  }

  /** Reads a named conversation without claiming it. Used by inject-only probes. */
  peekKey(agentName, key, { whenBusy = "fork" } = {}) {
    return this.#matchKey(agentName, key, whenBusy, false);
  }

  #matchKey(agentName, key, whenBusy, claim) {
    const convId = this.#keys.get(`${agentName} ${key}`);
    if (!convId) return null;
    const conv = this.#conversations.get(convId);
    // Stale key: the conversation it named has expired, been evicted or closed.
    if (!conv) {
      if (claim) this.#keys.delete(`${agentName} ${key}`);
      return null;
    }
    if (this.#expired(conv)) return null;
    // Mid-turn, and there are two defensible answers.
    //
    // `fork` -- despite the historical name, a named conversation now reports 409:
    // silently forking loses the direct identity the caller asserted with its key.
    //
    // `queue` -- the caller named a conversation that is mid-turn, and on a coding
    // agent that is rarely a race. It is someone adding to work already under way,
    // and the running turn is exactly where it belongs. Reported rather than acted
    // on here: whether the agent can accept it is a question about the AGENT.
    if (conv.busy) {
      // Waiting on a tool result is not the same busy as working. The turn is
      // suspended inside a call this server is holding open, and the request that
      // carries the answer must reach it -- whatever `busy` is set to, since it is
      // a continuation of that turn rather than a second one.
      if (conv.pending) {
        if (claim) conv.lastUsed = this.now();
        return {
          convId,
          session: conv.session,
          sessionId: conv.sessionId,
          bench: conv.bench,
          pending: conv.pending,
          prefix: conv.prefix,
          matched: conv.prefix.length,
          resumeContext: conv.resumeContext,
        };
      }
      if (claim) conv.lastUsed = this.now();
      return {
        convId,
        session: conv.session,
        sessionId: conv.sessionId,
        busy: true,
        queue: whenBusy === "queue" && Boolean(conv.session),
        matched: conv.prefix.length,
        prefix: conv.prefix,
        resumeContext: conv.resumeContext,
      };
    }
    // Out of room. The key still names this conversation, and the next `prune`
    // will close it; what the caller gets is a fresh session under the same key,
    // which is the only thing a full context can be answered with.
    if (this.#full(conv)) return null;
    if (claim) {
      conv.busy = true;
      conv.lastUsed = this.now();
    }
    // `session` is null when the conversation is parked. The caller revives it from
    // `sessionId` before using it -- see `revive`.
    return {
      convId,
      session: conv.session,
      sessionId: conv.sessionId,
      bench: conv.bench,
      matched: conv.prefix.length,
      prefix: conv.prefix,
      resumeContext: conv.resumeContext,
    };
  }

  /** The tool bench serving this conversation, or null. */
  bench(convId) {
    return this.#conversations.get(convId)?.bench ?? null;
  }

  /** Whether a turn of this conversation is suspended inside a tool call. */
  isPending(convId) {
    return Boolean(this.#conversations.get(convId)?.pending);
  }

  /** Reads a suspended turn by conversation id without claiming its existing owner. */
  peekPending(convId) {
    const conv = this.#conversations.get(convId);
    if (!conv?.pending) return null;
    return {
      convId,
      session: conv.session,
      sessionId: conv.sessionId,
      bench: conv.bench,
      pending: conv.pending,
      prefix: conv.prefix,
      matched: conv.prefix.length,
      resumeContext: conv.resumeContext,
    };
  }

  /**
   * Records a turn suspended inside a tool call, or clears it.
   *
   * While this is set the conversation stays busy and `matchKey` hands the turn
   * back rather than reporting a conflict: the next request is not a second turn,
   * it is the rest of this one.
   */
  setPending(convId, pending) {
    const conv = this.#conversations.get(convId);
    if (!conv) return;
    if (conv.pending && conv.pending !== pending) this.#clearPending(convId, conv);
    conv.pending = pending;
    conv.lastUsed = this.now();
    if (!pending) return;
    if (!pending.releaseWatched) {
      pending.releaseWatched = true;
      const settled = () => {
        pending.settled = true;
        this.#releaseSettledPending(convId, pending);
      };
      pending.turn.then(settled, settled);
    }
    // Covers the race where the turn settled while a request was attached, then
    // that request disconnected and put the same pending object back.
    this.#releaseSettledPending(convId, pending);
  }

  /**
   * Finds a live session this history CONTINUES, and says how much of it the
   * session has already heard.
   *
   * This is what turns a stateless caller into a continuous conversation. A client
   * that resends its whole history every time (which is what the OpenAI API asks
   * for) otherwise gets a cold agent each turn: it re-reads a growing transcript and
   * loses whatever working state it had built up.
   *
   * Matching is by longest prefix, because that is the most specific continuation.
   * A history that diverges -- edited, branched, trimmed -- simply matches nothing
   * and gets a fresh session, which is the correct answer rather than a fallback.
   */
  matchPrefix(agentName, systemId, prefix) {
    return this.#matchPrefix(agentName, systemId, prefix, true);
  }

  /** Reads a prefix match without claiming it. Used by inject-only probes. */
  peekPrefix(agentName, systemId, prefix) {
    return this.#matchPrefix(agentName, systemId, prefix, false);
  }

  #matchPrefix(agentName, systemId, prefix, claim) {
    let best = null;
    for (const [convId, conv] of this.#conversations) {
      // A session serves one turn at a time; handing a second turn to a busy one
      // would interleave two conversations inside the agent. A PENDING turn is
      // different: the matching history is how a headerless caller finds the
      // exact turn whose tool result it is carrying.
      if (this.#expired(conv)) continue;
      if ((conv.busy && !conv.pending) || conv.agentName !== agentName || conv.systemId !== systemId) continue;
      if (this.#full(conv)) continue;
      // The standing preamble is part of identity: a changed system prompt is a
      // different brief, and continuing under the old one would be a lie.
      if (conv.prefix.length > prefix.length) continue;
      if (!conv.prefix.every((fp, i) => fp === prefix[i])) continue;
      if (!best || conv.prefix.length > best.matched) best = { convId, conv, matched: conv.prefix.length };
    }
    if (!best) return null;
    if (claim) {
      if (!best.conv.pending) best.conv.busy = true;
      best.conv.lastUsed = this.now();
    }
    return {
      convId: best.convId,
      session: best.conv.session,
      sessionId: best.conv.sessionId,
      bench: best.conv.bench,
      matched: best.matched,
      resumeContext: best.conv.resumeContext,
      ...(best.conv.pending
        ? { pending: best.conv.pending, prefix: best.conv.prefix }
        : {}),
    };
  }

  /** Records what a session has now heard, so the next request can extend it. */
  extendPrefix(convId, prefix) {
    const conv = this.#conversations.get(convId);
    if (!conv) return;
    conv.prefix = [...prefix];
    conv.lastUsed = this.now();
  }

  /**
   * The session usage totals already reported to the caller, or null before the
   * first turn.
   *
   * ACP counts tokens cumulatively across a session ("Total input tokens across
   * all turns"), and a retained session serves many requests, so a turn's own cost
   * is only the difference against this. Without it every response re-reports the
   * whole conversation's spend as its own.
   */
  usageBaseline(convId) {
    return this.#conversations.get(convId)?.usage ?? null;
  }

  /** Stores the totals a turn reported, as the next turn's baseline. */
  rememberUsage(convId, usage) {
    const conv = this.#conversations.get(convId);
    if (conv && usage) conv.usage = usage;
  }

  /**
   * The cumulative session cost already reported, for exactly the reason
   * `usageBaseline` exists: `usage_update.cost` is what the SESSION has spent, and
   * a retained session spends across a whole conversation.
   */
  costBaseline(convId) {
    return this.#conversations.get(convId)?.cost ?? null;
  }

  /** Which agent a conversation belongs to -- the label every metric is keyed by. */
  agentOf(convId) {
    return this.#conversations.get(convId)?.agentName ?? null;
  }

  /** Stores the cumulative cost a turn reported, as the next turn's baseline. */
  rememberCost(convId, cost) {
    const conv = this.#conversations.get(convId);
    if (conv && Number.isFinite(cost?.amount)) conv.cost = cost;
  }

  /**
   * Records how full the session's context window is, from `usage_update`.
   *
   * The last reading wins rather than the highest: a compaction genuinely frees
   * room, and a session that just compacted should not stay retired for a peak it
   * has already come down from.
   */
  rememberContext(convId, context) {
    const conv = this.#conversations.get(convId);
    if (!conv || !context?.size) return;
    conv.fill = context.used / context.size;
    if (this.#full(conv)) {
      this.log("info", `session ${convId} (${conv.agentName}) retired: context ${Math.round(conv.fill * 100)}% full`);
    }
  }

  #expireTombstones() {
    const cutoff = this.now() - this.forgetTtlMs;
    this.#tombstones = this.#tombstones.filter((tombstone) => tombstone.at > cutoff);
  }

  #rememberTombstone(conv, reason) {
    if (!conv.replayable) return;
    this.#expireTombstones();
    const prefixFingerprints = conv.prefix.length ? [conv.systemId, ...conv.prefix] : null;
    if (!conv.key && !prefixFingerprints) return;
    this.#tombstones.push({
      ...(conv.key ? { key: conv.key } : {}),
      ...(prefixFingerprints ? { prefixFingerprints } : {}),
      agentName: conv.agentName,
      reason,
      at: this.now(),
    });
    if (this.#tombstones.length > this.tombstoneMax) {
      this.#tombstones.splice(0, this.#tombstones.length - this.tombstoneMax);
    }
  }

  /** Consumes the most specific retirement matching a fresh Chat conversation. */
  consumeRetirement(agentName, { key = null, systemId = null, prefix = [] } = {}) {
    this.#expireTombstones();
    let found = -1;
    if (key) {
      for (let i = this.#tombstones.length - 1; i >= 0; i -= 1) {
        const tombstone = this.#tombstones[i];
        if (tombstone.agentName === agentName && tombstone.key === key) {
          found = i;
          break;
        }
      }
    }
    if (found < 0) {
      const incoming = [systemId, ...prefix];
      let longest = -1;
      for (let i = 0; i < this.#tombstones.length; i += 1) {
        const tombstone = this.#tombstones[i];
        const recorded = tombstone.prefixFingerprints;
        if (tombstone.agentName !== agentName || !recorded || recorded.length > incoming.length) continue;
        if (!recorded.every((value, index) => value === incoming[index])) continue;
        if (recorded.length >= longest) {
          found = i;
          longest = recorded.length;
        }
      }
    }
    if (found < 0) return null;
    const [tombstone] = this.#tombstones.splice(found, 1);
    return { replayed: true, reason: tombstone.reason };
  }

  /** Marks a conversation as serving a turn, so no other request joins it. */
  claim(convId) {
    const conv = this.#conversations.get(convId);
    if (!conv || this.#expired(conv) || conv.busy) return false;
    conv.busy = true;
    conv.lastUsed = this.now();
    return true;
  }

  /** Releases or restores busy state after ownership has already been decided. */
  setBusy(convId, busy) {
    const conv = this.#conversations.get(convId);
    if (conv) {
      conv.busy = busy;
      if (!busy) conv.owner = null;
    }
  }

  /** Resolves a response id for inspection. Old retained responses remain readable. */
  find(responseId) {
    const entry = this.#responses.get(responseId);
    if (!entry) return null;
    const conv = this.#conversations.get(entry.convId);
    if (!conv || this.#expired(conv)) return null;
    const latest = conv.latestResponseId === responseId;
    if (latest) conv.lastUsed = this.now();
    return { convId: entry.convId, ...conv, latest };
  }

  /**
   * Resolves and synchronously claims only the latest response in a chain.
   *
   * `continuation` is one of `claimed`, `busy`, or `stale`. Unknown, evicted and
   * expired ids return null. A claim carries an opaque token; releaseResponseClaim
   * refuses to release a later owner accidentally.
   */
  claimResponse(responseId) {
    const entry = this.#responses.get(responseId);
    if (!entry) return null;
    const conv = this.#conversations.get(entry.convId);
    if (!conv || this.#expired(conv)) return null;
    if (conv.latestResponseId !== responseId) {
      return { convId: entry.convId, ...conv, continuation: "stale", busy: conv.busy };
    }
    conv.lastUsed = this.now();
    if (conv.busy) {
      if (conv.pending && !conv.pending.attached && !conv.owner) {
        const claimId = nextId("claim");
        conv.pending.attached = true;
        conv.owner = claimId;
        return { convId: entry.convId, ...conv, continuation: "claimed", claimId, busy: true };
      }
      return { convId: entry.convId, ...conv, continuation: "busy", busy: true };
    }
    const claimId = nextId("claim");
    conv.busy = true;
    conv.owner = claimId;
    return { convId: entry.convId, ...conv, continuation: "claimed", claimId, busy: false };
  }

  /** Releases exactly the response continuation owner returned by claimResponse. */
  releaseResponseClaim(convId, claimId) {
    const conv = this.#conversations.get(convId);
    if (!conv || !claimId || conv.owner !== claimId) return false;
    conv.owner = null;
    if (conv.pending) {
      conv.pending.attached = false;
      this.#releaseSettledPending(convId, conv.pending);
    } else {
      conv.busy = false;
    }
    return true;
  }

  /** The stored response body, for `GET /v1/responses/{id}`. */
  response(responseId) {
    const entry = this.#responses.get(responseId);
    return entry?.response ?? null;
  }

  #dropResponse(responseId) {
    const entry = this.#responses.get(responseId);
    if (!entry) return false;
    this.#responses.delete(responseId);
    this.#responseBytes -= entry.bytes;
    this.#conversations.get(entry.convId)?.responses.delete(responseId);
    return true;
  }

  /** Records a completed response, evicting oldest non-tip snapshots if needed. */
  record(convId, responseId, response) {
    const conv = this.#conversations.get(convId);
    if (!conv) throw new ResponseStorageError("response conversation no longer exists");
    let serialized;
    try {
      serialized = JSON.stringify(response);
    } catch (error) {
      throw new ResponseStorageError(`response is not serializable: ${error.message}`);
    }
    if (serialized === undefined) throw new ResponseStorageError("response is not JSON-serializable");
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxResponseBytes || this.maxResponses < 1) {
      throw new ResponseStorageError(
        `response requires ${bytes} bytes but storage allows ${this.maxResponseBytes} bytes and ${this.maxResponses} responses`,
      );
    }

    // The previous tip of this same chain becomes stale as part of this commit, so
    // it is a valid eviction candidate. Tips of other conversations are protected:
    // evicting one would leave a live ACP session with a false older branch point.
    const candidates = [...this.#responses.entries()]
      .filter(([id, entry]) => {
        const owner = this.#conversations.get(entry.convId);
        return entry.convId === convId || owner?.latestResponseId !== id;
      })
      .sort((a, b) => a[1].storedAt - b[1].storedAt || a[0].localeCompare(b[0]));
    let projectedCount = this.#responses.size + (this.#responses.has(responseId) ? 0 : 1);
    let projectedBytes = this.#responseBytes - (this.#responses.get(responseId)?.bytes ?? 0) + bytes;
    const evict = [];
    for (const [id, entry] of candidates) {
      if (projectedCount <= this.maxResponses && projectedBytes <= this.maxResponseBytes) break;
      if (id === responseId) continue;
      evict.push(id);
      projectedCount -= 1;
      projectedBytes -= entry.bytes;
    }
    if (projectedCount > this.maxResponses || projectedBytes > this.maxResponseBytes) {
      throw new ResponseStorageError("response storage is full of current conversation tips");
    }

    for (const id of evict) this.#dropResponse(id);
    this.#dropResponse(responseId);
    conv.responses.add(responseId);
    conv.lastUsed = this.now();
    conv.latestResponseId = responseId;
    // Store the exact JSON value whose bytes were admitted. Callers may still hold
    // and mutate `response` (the SSE assembler used to do exactly that), so keeping
    // its reference would make both the byte accounting and GET snapshot lie.
    this.#responses.set(responseId, {
      convId,
      response: freezeJson(serialized),
      bytes,
      storedAt: this.now(),
    });
    this.#responseBytes += bytes;
  }

  /**
   * Forgets one response. The ACP session closes only when the last response of its
   * conversation goes -- deleting one turn must not silently end the conversation
   * the caller is still using.
   */
  async forget(responseId, agents) {
    const entry = this.#responses.get(responseId);
    if (!entry) return false;
    this.#dropResponse(responseId);
    const conv = this.#conversations.get(entry.convId);
    if (!conv) return true;
    // Deleting the tip removes the only legal continuation point. Keep older
    // snapshots readable, but close the ACP conversation they can no longer name.
    if (conv.latestResponseId === responseId || conv.responses.size === 0) {
      await this.#close(entry.convId, "deleted", agents, null, { preserveResponses: true });
    }
    return true;
  }

  /** Ends an advanced `store:false` chain but preserves its older GET snapshots. */
  async finishUnstored(convId, agents) {
    const conv = this.#conversations.get(convId);
    if (!conv) return false;
    await this.#close(convId, "unstored response", agents, null, { preserveResponses: true });
    return true;
  }

  /**
   * Makes room for one new conversation, closing the least-recently-used idle
   * record if necessary. If every slot is active the caller gets an admission
   * error instead of silently exceeding the storage bound.
   */
  prepareOpen(agents) {
    const previous = this.#admissionTail;
    let unlock;
    this.#admissionTail = new Promise((resolve) => { unlock = resolve; });
    return previous.then(() => this.#prepareOpen(agents)).finally(unlock);
  }

  async #prepareOpen(agents) {
    await this.cleanup(agents);
    if (this.#closed) throw new SessionCapacityError("session store is closed");
    if (this.maxConversations < 1) {
      throw new SessionCapacityError("conversation storage is disabled (maxConversations is 0)");
    }
    if (this.#conversations.size + this.#admissions.size < this.maxConversations) {
      const admissionId = nextId("admit");
      this.#admissions.add(admissionId);
      return admissionId;
    }
    const idle = [...this.#conversations.entries()]
      .filter(([, conv]) => !conv.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed || a[0].localeCompare(b[0]));
    if (idle.length === 0) {
      throw new SessionCapacityError(
        `conversation storage is full (${this.maxConversations}) and every conversation is active`,
      );
    }
    await this.#close(idle[0][0], "conversation capacity", agents);
    if (this.#closed) throw new SessionCapacityError("session store is closed");
    const admissionId = nextId("admit");
    this.#admissions.add(admissionId);
    return admissionId;
  }

  /** Releases capacity reserved by prepareOpen when opening the ACP session fails. */
  cancelOpen(admissionId) {
    return this.#admissions.delete(admissionId);
  }

  /** Runs one non-overlapping cleanup pass; callers may await it deterministically. */
  cleanup(agents) {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = this.prune(agents).finally(() => {
      this.#cleanupPromise = null;
    });
    return this.#cleanupPromise;
  }

  /** Starts periodic cleanup. The unref'ed timer never keeps Node alive. */
  startCleanup(agents, { intervalMs = Math.max(1_000, Math.min(this.ttlMs, 60_000)) } = {}) {
    if (this.#cleanupTimer || this.#closed) return false;
    this.#cleanupTimer = setInterval(() => {
      this.cleanup(agents).catch((error) => this.log("error", `session cleanup failed: ${error.message}`));
    }, intervalMs);
    this.#cleanupTimer.unref?.();
    return true;
  }

  /** Stops future cleanup passes. An already-running pass remains awaitable. */
  async stopCleanup() {
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    this.#cleanupTimer = null;
    await this.#cleanupPromise;
  }

  /**
   * Parks conversations that are over the TTL, then the oldest ones until the cap
   * is met. Called before every open, so the store cannot grow between requests.
   *
   * Eviction is by LAST USE, not by age: a long conversation someone is actively
   * continuing must outlive an abandoned one started later.
   *
   * Both bounds now PARK rather than close, so going quiet costs a conversation its
   * resident session and not its memory of the work. What actually ends a
   * conversation is `forgetTtlMs` -- long enough that a thread returned to the next
   * morning still continues -- or a context window it has filled, which no amount
   * of resuming can help with.
   */
  async prune(agents) {
    // A busy conversation is mid-turn: touching it would cancel work already paid
    // for and leave the caller with nothing.
    const idleCutoff = this.now() - this.ttlMs;
    const forgetCutoff = this.now() - this.forgetTtlMs;
    for (const [convId, conv] of this.#conversations) {
      if (conv.busy) continue;
      // Retired: it has stopped being offered, and resuming a session with no room
      // left in its context would only hit the same wall again.
      if (this.#full(conv)) await this.retire(convId, "context_fill", agents);
      else if (conv.lastUsed <= forgetCutoff) await this.retire(convId, "forgotten", agents);
      else if (conv.lastUsed <= idleCutoff) await this.park(convId, agents);
    }
    // The cap is a bound on RESIDENT sessions -- the expensive thing -- so parked
    // conversations, which hold no process, do not count towards it.
    const live = [...this.#conversations.entries()].filter(([, c]) => !c.busy && c.session);
    if (live.length <= this.max) return;
    const byAge = live.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [convId] of byAge.slice(0, live.length - this.max)) {
      await this.park(convId, agents);
    }
  }

  /**
   * Drops a conversation outright.
   *
   * Used when a turn fails before producing a response: a conversation with no
   * response is unreachable forever, and leaving it would retain a live login that
   * nothing can ever close.
   */
  async discard(convId, agents) {
    await this.#close(convId, "discarded", agents);
  }

  /** Retires a conversation under the closed, metrics-safe reason vocabulary. */
  async retire(convId, reason, agents) {
    const why = RETIREMENT_REASONS[reason];
    if (!why) throw new Error(`unknown retirement reason "${reason}"`);
    await this.#close(convId, why, agents, reason);
  }

  /**
   * Frees a conversation's agent-side resources while keeping the conversation.
   *
   * `session/close` is defined as "cancel any ongoing work and free up resources"
   * -- it is not `session/delete`, which is what removes a session for good. So a
   * conversation nobody has returned to can give back its live session and keep
   * only the id, and the next message restores it with `session/resume`.
   *
   * That is the difference between a thread going quiet for an hour and a thread
   * losing everything it had read. It also means the cap and the TTL stop being a
   * bound on CONVERSATIONS and become a bound on resident sessions, which is the
   * resource they were always really about.
   *
   * Parking is unconditional and self-correcting: an agent that cannot resume
   * simply fails the revive, and the caller opens a fresh session. Asking first
   * would mean starting the agent's process during a prune to find out.
   */
  async park(convId, agents) {
    const conv = this.#conversations.get(convId);
    if (!conv || conv.busy || !conv.session) return;
    const session = conv.session;
    conv.session = null;
    conv.parkedAt = this.now();
    this.#reportLive(conv.agentName);
    this.log("info", `session ${convId} (${conv.agentName}) parked: ${conv.sessionId}`);
    await agents?.get(conv.agentName)?.closeSession(session);
  }

  /**
   * Puts a revived session back on a parked conversation.
   *
   * The agent may answer `session/resume` with a different id than it was asked
   * for, so the id is taken from the session rather than assumed unchanged.
   */
  revive(convId, session) {
    const conv = this.#conversations.get(convId);
    if (!conv || !session || this.#expired(conv)) return false;
    conv.session = session;
    conv.sessionId = session.id;
    conv.parkedAt = null;
    conv.lastUsed = this.now();
    this.#reportLive(conv.agentName);
    return true;
  }

  /** Ends every conversation. Shutdown depends on this reaping the child processes. */
  async closeAll(agents) {
    this.#closed = true;
    await this.#admissionTail;
    await this.stopCleanup();
    for (const convId of [...this.#conversations.keys()]) await this.#close(convId, "shutdown", agents);
    // Includes orphaned GET-only snapshots preserved after store:false or deleting
    // a tip. The store is terminal after shutdown, so retaining them serves nobody.
    this.#responses.clear();
    this.#responseBytes = 0;
    this.#admissions.clear();
  }

  async #close(convId, why, agents, retirementReason = null, { preserveResponses = false } = {}) {
    const conv = this.#conversations.get(convId);
    if (!conv) return;
    this.#clearPending(convId, conv);
    this.#conversations.delete(convId);
    if (!preserveResponses) {
      for (const id of [...conv.responses]) this.#dropResponse(id);
    }
    // Only if it still points here: a key rebound to a newer session by `open`
    // must not be dropped when the one it used to name is reaped.
    const keyed = conv.key ? `${conv.agentName} ${conv.key}` : null;
    if (keyed && this.#keys.get(keyed) === convId) this.#keys.delete(keyed);
    this.#reportLive(conv.agentName);
    if (retirementReason) {
      this.#rememberTombstone(conv, retirementReason);
      this.metrics?.retired(conv.agentName, retirementReason);
    }
    this.log("info", `session ${convId} (${conv.agentName}) closed: ${why}`);
    // Before the session goes: anything else attached to this conversation has to
    // go too, or a tool call held open outlives everything that could answer it.
    try {
      this.onClose(conv);
    } catch {
      /* a cleanup hook must not stop a conversation from being reaped */
    }
    // A parked conversation has already given its session back; there is nothing
    // left to close, and only the record goes. The agent's own stored history is
    // NOT deleted -- `session/delete` is a separate, destructive act, and whose
    // transcripts those are is the agent's business rather than this store's.
    if (conv.session) await agents?.get(conv.agentName)?.closeSession(conv.session);
  }
}
