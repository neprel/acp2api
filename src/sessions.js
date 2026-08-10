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

let counter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const newResponseId = () => nextId("resp");

export class SessionStore {
  #conversations = new Map(); // convId -> {agentName, session, responses:Set, lastUsed}
  #responses = new Map(); // responseId -> {convId, response}

  constructor({ max = 100, ttlMs = 3_600_000, now = () => Date.now(), log = () => {} } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.log = log;
  }

  get size() {
    return this.#conversations.size;
  }

  /** Starts a conversation around a freshly opened session. Returns its id. */
  open(agentName, session) {
    const convId = nextId("conv");
    this.#conversations.set(convId, {
      agentName,
      session,
      responses: new Set(),
      lastUsed: this.now(),
    });
    return convId;
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
   * Closes conversations that are over the TTL, then the oldest ones until the cap
   * is met. Called before every open, so the store cannot grow between requests.
   *
   * Eviction is by LAST USE, not by age: a long conversation someone is actively
   * continuing must outlive an abandoned one started later.
   */
  async prune(agents) {
    const cutoff = this.now() - this.ttlMs;
    for (const [convId, conv] of this.#conversations) {
      if (conv.lastUsed < cutoff) await this.#close(convId, "expired", agents);
    }
    if (this.#conversations.size <= this.max) return;
    const byAge = [...this.#conversations.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [convId] of byAge.slice(0, this.#conversations.size - this.max)) {
      await this.#close(convId, "evicted", agents);
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

  /** Ends every conversation. Shutdown depends on this reaping the child processes. */
  async closeAll(agents) {
    for (const convId of [...this.#conversations.keys()]) await this.#close(convId, "shutdown", agents);
  }

  async #close(convId, why, agents) {
    const conv = this.#conversations.get(convId);
    if (!conv) return;
    this.#conversations.delete(convId);
    for (const id of conv.responses) this.#responses.delete(id);
    this.log("info", `session ${convId} (${conv.agentName}) closed: ${why}`);
    await agents?.get(conv.agentName)?.closeSession(conv.session);
  }
}
