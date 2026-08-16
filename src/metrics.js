/**
 * What this bridge knows about spend, in the one format that scrapes.
 *
 * WHY IT LIVES HERE AND NOT IN THE AGENTS
 * ---------------------------------------
 * Every coding CLI has its own telemetry: codex writes `codex.turn.token_usage`
 * over OTLP if you configure `[otel]` in its config.toml, Claude Code writes
 * `claude_code.token.usage` if you set `CLAUDE_CODE_ENABLE_TELEMETRY`. Wiring each
 * one means a different mechanism, a different metric namespace and a different
 * label set per agent, repeated for every agent added later -- and the registry
 * has thirty-eight.
 *
 * This bridge is the one component every agent passes through, and it ALREADY
 * normalizes their counters: `Usage` off the `session/prompt` response, turned from
 * session-cumulative into per-turn by `deltaUsage`. Exporting from here is one
 * mechanism, one namespace and one label set for all of them, and an agent added
 * tomorrow is measured on the day it is added.
 *
 * NO DEPENDENCY. The Prometheus text format is a line per sample; a client library
 * would be a fifth package for string concatenation.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * *Quota* -- how much of a subscription is left. ACP has no concept of it for any
 * agent (see _.hint#limit_detection), so the only uniform signal is what already
 * exists: a turn that ended in `rate_limited`. Anything better is one vendor's
 * private file format, and does not belong in a protocol bridge.
 *
 * *Conversation ids* as a label. Unbounded cardinality; the whole point of a
 * conversation here is that there can be arbitrarily many.
 */

/** Characters Prometheus forbids in a label value, and their escapes. */
const ESCAPES = { "\\": "\\\\", '"': '\\"', "\n": "\\n" };

const escape = (v) => String(v).replace(/[\\"\n]/g, (c) => ESCAPES[c]);

/** A metric or label NAME must match this; anything else is dropped rather than emitted broken. */
const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function renderLabels(labels) {
  const parts = [];
  for (const [k, v] of Object.entries(labels)) {
    if (v == null || v === "" || !NAME.test(k)) continue;
    parts.push(`${k}="${escape(v)}"`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

/**
 * The counters and gauges, keyed by their rendered label set.
 *
 * Everything is process-lifetime and in memory. A restart resets the counters,
 * which is what `rate()` and `increase()` are built to survive -- persisting them
 * would add a store and buy nothing a scrape interval cannot already see.
 */
export class Metrics {
  #counters = new Map(); // metricName -> Map(labelString -> number)
  #gauges = new Map(); // metricName -> Map(labelString -> number)
  #histograms = new Map(); // metricName -> Map(labelString -> {buckets, sum, count})
  #buckets;
  #agentLabels;

  /**
   * @param {object} [opts]
   * @param {Record<string, Record<string, string>>} [opts.agentLabels]
   *   Per-agent operator labels, merged into every sample for that agent. This is
   *   how `account` gets onto the metrics: which subscription an agent spends is a
   *   property of the login in its home directory, which no protocol reports and
   *   only the operator knows. Declared, not discovered -- and free-form, so the
   *   same mechanism carries `plan`, `owner` or anything else without a new field.
   * @param {number[]} [opts.buckets] duration histogram bounds, seconds.
   */
  constructor({ agentLabels = {}, buckets } = {}) {
    this.#agentLabels = agentLabels;
    // A coding agent's turn is not a web request: seconds to many minutes is
    // normal, so the default web-latency ladder would put everything in +Inf.
    this.#buckets = buckets ?? [1, 5, 15, 30, 60, 120, 300, 600, 1800];
  }

  #withAgent(labels) {
    const extra = (labels.agent && this.#agentLabels[labels.agent]) || {};
    return { ...extra, ...labels };
  }

  #bump(store, name, labels, by) {
    const key = renderLabels(this.#withAgent(labels));
    let series = store.get(name);
    if (!series) store.set(name, (series = new Map()));
    series.set(key, (series.get(key) ?? 0) + by);
  }

  counter(name, labels = {}, by = 1) {
    if (by) this.#bump(this.#counters, name, labels, by);
  }

  gauge(name, labels = {}, value) {
    const key = renderLabels(this.#withAgent(labels));
    let series = this.#gauges.get(name);
    if (!series) this.#gauges.set(name, (series = new Map()));
    series.set(key, value);
  }

  observe(name, labels, seconds) {
    if (!Number.isFinite(seconds)) return;
    const key = renderLabels(this.#withAgent(labels));
    let series = this.#histograms.get(name);
    if (!series) this.#histograms.set(name, (series = new Map()));
    let h = series.get(key);
    if (!h) series.set(key, (h = { buckets: new Array(this.#buckets.length).fill(0), sum: 0, count: 0 }));
    h.sum += seconds;
    h.count += 1;
    for (let i = 0; i < this.#buckets.length; i += 1) {
      if (seconds <= this.#buckets[i]) h.buckets[i] += 1;
    }
  }

  /**
   * How a turn ended, and how long it took. Recorded for EVERY turn, including the
   * ones that threw, which is why it lives at `Agent#turn` -- the one funnel every
   * caller path goes through.
   *
   * There is no `model` label: in this bridge the OpenAI "model" IS the agent name,
   * so a second column would repeat the first. Which CLI sits behind the name is
   * worth knowing and is exactly what the operator's own labels are for.
   */
  recordOutcome({ agent, outcome, seconds }) {
    this.counter("acp2api_turns_total", { agent, outcome });
    this.observe("acp2api_turn_duration_seconds", { agent }, seconds);
  }

  /**
   * What a turn actually spent, AFTER settling -- the counters ACP reports are
   * cumulative for the session, so recording them raw would re-count the whole
   * conversation on every turn.
   *
   * Only called when the agent reported something. The gap between
   * `acp2api_turns_total` and `acp2api_usage_reported_total` is the point: an agent
   * whose turns climb while its tokens stay flat is not free, it is UNMEASURED, and
   * that has to be visible instead of reading as zero.
   */
  recordUsage({ agent, usage, cost, context }) {
    if (usage) {
      this.counter("acp2api_usage_reported_total", { agent });
      const kinds = {
        input: usage.inputTokens,
        cached_read: usage.cachedReadTokens,
        cached_write: usage.cachedWriteTokens,
        output: usage.outputTokens,
        reasoning: usage.thoughtTokens,
      };
      for (const [kind, n] of Object.entries(kinds)) {
        if (Number.isFinite(n) && n > 0) this.counter("acp2api_tokens_total", { agent, kind }, n);
      }
    }
    if (Number.isFinite(cost?.amount) && cost.amount > 0) {
      this.counter("acp2api_cost_total", { agent, currency: cost.currency ?? "USD" }, cost.amount);
    }
    // A ratio rather than the raw pair: the window size is the agent's business and
    // moves with the model, while "how close to full" is the thing to alert on.
    if (context?.size > 0) this.gauge("acp2api_context_fill_ratio", { agent }, context.used / context.size);
  }

  sessions(agent, live) {
    this.gauge("acp2api_sessions_live", { agent }, live);
  }

  /** The whole registry in Prometheus text exposition format. */
  render() {
    const out = [];
    const dump = (store, type, help) => {
      for (const [name, series] of store) {
        out.push(`# HELP ${name} ${help[name] ?? name}`, `# TYPE ${name} ${type}`);
        for (const [labels, value] of series) out.push(`${name}${labels} ${value}`);
      }
    };
    dump(this.#counters, "counter", HELP);
    dump(this.#gauges, "gauge", HELP);
    for (const [name, series] of this.#histograms) {
      out.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} histogram`);
      for (const [labels, h] of series) {
        const inner = labels.slice(1, -1);
        const with_ = (extra) => `{${inner ? `${inner},` : ""}${extra}}`;
        for (let i = 0; i < this.#buckets.length; i += 1) {
          out.push(`${name}_bucket${with_(`le="${this.#buckets[i]}"`)} ${h.buckets[i]}`);
        }
        out.push(`${name}_bucket${with_('le="+Inf"')} ${h.count}`);
        out.push(`${name}_sum${labels} ${h.sum}`);
        out.push(`${name}_count${labels} ${h.count}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
}

/**
 * The metrics listener: a second server, on an address of its own.
 *
 * Separate from the API port because the two have different exposure decisions --
 * the API has no authentication and stays on loopback, while metrics exist to be
 * scraped from somewhere else. Nothing here is authenticated either, so the address
 * is the whole access control and the operator picks it deliberately.
 */
export function metricsServer(metrics, { createServer }) {
  return createServer((req, res) => {
    if (req.url === "/metrics" || req.url === "/") {
      const body = metrics.render();
      res.writeHead(200, {
        // The version Prometheus negotiates for the plain text format.
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      return res.end(body);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
}

const HELP = {
  acp2api_turns_total: "Turns completed, by how they ended.",
  acp2api_usage_reported_total: "Turns whose agent reported token counts at all.",
  acp2api_tokens_total: "Tokens, per turn, by kind. Absent when the agent reports none.",
  acp2api_cost_total: "Cost the agent reported for its own turns, in its own currency.",
  acp2api_context_fill_ratio: "How full a session's context window is, 0 to 1.",
  acp2api_sessions_live: "Sessions currently held open.",
  acp2api_turn_duration_seconds: "Wall-clock time from prompt to answer.",
};
