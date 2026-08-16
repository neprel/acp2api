/**
 * Live ACP sessions behind the Responses API.
 *
 * This is what makes `previous_response_id` mean something. Chat completions are
 * stateless and must resend the whole history every time, which the agent then has
 * to read as one flattened transcript. A retained ACP session already holds the
 * conversation, so a continued turn sends **only the new input** -- less to send,
 * and the agent's own memory of the turn rather than our rendering of it.
 *
 * The unit of retention is a CONVERSATION, not a response: a chain of responses
 * shares one ACP session, and every response id in the chain resolves to it. That is
 * why `previous_response_id` may point anywhere in the chain, not just at its tip.
 *
 * Every retained session is a live child process holding an authenticated login, so
 * nothing here may leak: eviction and expiry both close the ACP session, and so does
 * shutdown.
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

export const fingerprint = (m) =>
  digest([m?.role ?? null, m?.content ?? null, m?.tool_calls ?? null, m?.tool_call_id ?? null, m?.name ?? null]);

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

  constructor({
    max = 100,
    ttlMs = 3_600_000,
    forgetTtlMs = 86_400_000,
    maxContextFill = 0,
    now = () => Date.now(),
    log = () => {},
    onClose = () => {},
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
    this.max = max;
    this.ttlMs = ttlMs;
    // When a conversation stops being a conversation at all. `ttlMs` now only
    // decides when it gives back its resident session; this decides when the id is
    // dropped and the next message genuinely starts over.
    this.forgetTtlMs = Math.max(forgetTtlMs, ttlMs);
    // How full a session's context window may get before it stops being offered to
    // the next request. 0 disables the check entirely. See `#full`.
    this.maxContextFill = maxContextFill;
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

  get size() {
    return this.#conversations.size;
  }

  /** Starts a conversation around a freshly opened session. Returns its id. */
  open(agentName, session, { systemId = null, prefix = [], key = null, bench = null } = {}) {
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
    });
    // Last writer wins. A caller reusing a key whose session is busy gets a new
    // one (see matchKey), and the key must then follow the session the caller is
    // actually talking to -- otherwise every later turn would keep finding the
    // abandoned one.
    if (key) this.#keys.set(`${agentName} ${key}`, convId);
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
    const convId = this.#keys.get(`${agentName} ${key}`);
    if (!convId) return null;
    const conv = this.#conversations.get(convId);
    // Stale key: the conversation it named has expired, been evicted or closed.
    if (!conv) {
      this.#keys.delete(`${agentName} ${key}`);
      return null;
    }
    // Mid-turn, and there are two defensible answers.
    //
    // `fork` -- two turns cannot interleave inside one agent, so this request gets
    // a session of its own. The same answer prefix matching gives, and the same
    // tradeoff: the caller sent a second turn before the first replied.
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
        conv.lastUsed = this.now();
        return { convId, session: conv.session, sessionId: conv.sessionId, bench: conv.bench, pending: conv.pending, prefix: conv.prefix, matched: conv.prefix.length };
      }
      if (whenBusy !== "queue" || !conv.session) return null;
      conv.lastUsed = this.now();
      return { convId, session: conv.session, sessionId: conv.sessionId, busy: true, matched: conv.prefix.length, prefix: conv.prefix };
    }
    // Out of room. The key still names this conversation, and the next `prune`
    // will close it; what the caller gets is a fresh session under the same key,
    // which is the only thing a full context can be answered with.
    if (this.#full(conv)) return null;
    conv.lastUsed = this.now();
    // `session` is null when the conversation is parked. The caller revives it from
    // `sessionId` before using it -- see `revive`.
    return {
      convId,
      session: conv.session,
      sessionId: conv.sessionId,
      bench: conv.bench,
      matched: conv.prefix.length,
      prefix: conv.prefix,
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
    conv.pending = pending;
    conv.lastUsed = this.now();
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
    let best = null;
    for (const [convId, conv] of this.#conversations) {
      // A session serves one turn at a time; handing a second turn to a busy one
      // would interleave two conversations inside the agent.
      if (conv.busy || conv.agentName !== agentName || conv.systemId !== systemId) continue;
      if (this.#full(conv)) continue;
      // The standing preamble is part of identity: a changed system prompt is a
      // different brief, and continuing under the old one would be a lie.
      if (conv.prefix.length > prefix.length) continue;
      if (!conv.prefix.every((fp, i) => fp === prefix[i])) continue;
      if (!best || conv.prefix.length > best.matched) best = { convId, conv, matched: conv.prefix.length };
    }
    if (!best) return null;
    best.conv.lastUsed = this.now();
    return {
      convId: best.convId,
      session: best.conv.session,
      sessionId: best.conv.sessionId,
      matched: best.matched,
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

  /** Marks a conversation as serving a turn, so no other request joins it. */
  setBusy(convId, busy) {
    const conv = this.#conversations.get(convId);
    if (conv) conv.busy = busy;
  }

  /** Resolves a response id to its conversation, or null. Refreshes its TTL. */
  find(responseId) {
    const entry = this.#responses.get(responseId);
    if (!entry) return null;
    const conv = this.#conversations.get(entry.convId);
    if (!conv) return null;
    conv.lastUsed = this.now();
    return { convId: entry.convId, ...conv };
  }

  /** The stored response body, for `GET /v1/responses/{id}`. */
  response(responseId) {
    return this.#responses.get(responseId)?.response ?? null;
  }

  /** Records a completed response against its conversation. */
  record(convId, responseId, response) {
    const conv = this.#conversations.get(convId);
    if (!conv) return;
    conv.responses.add(responseId);
    conv.lastUsed = this.now();
    this.#responses.set(responseId, { convId, response });
  }

  /**
   * Forgets one response. The ACP session closes only when the last response of its
   * conversation goes -- deleting one turn must not silently end the conversation
   * the caller is still using.
   */
  async forget(responseId, agents) {
    const entry = this.#responses.get(responseId);
    if (!entry) return false;
    this.#responses.delete(responseId);
    const conv = this.#conversations.get(entry.convId);
    if (!conv) return true;
    conv.responses.delete(responseId);
    if (conv.responses.size === 0) await this.#close(entry.convId, "deleted", agents);
    return true;
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
      if (this.#full(conv)) await this.#close(convId, "context full", agents);
      else if (conv.lastUsed < forgetCutoff) await this.#close(convId, "forgotten", agents);
      else if (conv.lastUsed < idleCutoff) await this.park(convId, agents);
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
    if (!conv || !session) return;
    conv.session = session;
    conv.sessionId = session.id;
    conv.parkedAt = null;
    conv.lastUsed = this.now();
  }

  /** Ends every conversation. Shutdown depends on this reaping the child processes. */
  async closeAll(agents) {
    for (const convId of [...this.#conversations.keys()]) await this.#close(convId, "shutdown", agents);
  }

  async #close(convId, why, agents) {
    const conv = this.#conversations.get(convId);
    if (!conv) return;
    this.#conversations.delete(convId);
    for (const id of conv.responses) this.#responses.delete(id);
    // Only if it still points here: a key rebound to a newer session by `open`
    // must not be dropped when the one it used to name is reaped.
    const keyed = conv.key ? `${conv.agentName} ${conv.key}` : null;
    if (keyed && this.#keys.get(keyed) === convId) this.#keys.delete(keyed);
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
