/**
 * What to do with the OpenAI parameters ACP cannot carry.
 *
 * `session/prompt` takes exactly `{sessionId, prompt, _meta}` -- no sampling
 * knobs, no tools, no response format. An ACP agent is an *agent*, not a raw model
 * endpoint: it owns its own inference settings and its own tool loop. Restarting
 * the CLI does not help either; `claude-agent-acp` reads only ANTHROPIC_MODEL,
 * MAX_THINKING_TOKENS and CLAUDE_CONFIG_DIR -- there is no temperature to set,
 * anywhere, at any layer.
 *
 * So the question is not "supported or not" but **what breaks if we proceed**, and
 * the two answers are genuinely different:
 *
 *   - Ignoring `temperature` changes the STYLE of the answer. Every client library
 *     sends it unasked, so rejecting it would fail nearly every real request for a
 *     difference the caller usually cannot even perceive.
 *   - Ignoring `tools` changes the CONTRACT. The caller is waiting for
 *     `tool_calls` and gets prose, then breaks somewhere inside its own agent loop
 *     with no clue why. A 400 here is kinder than a 200.
 *
 * Hence two lists rather than one setting. `server.unsupportedParams` governs the
 * first list only; the second is refused regardless, because "succeed at the wrong
 * thing" is not a mode worth offering.
 *
 * This module imports nothing on purpose: openai.js imports it, so importing
 * openai.js back would make a cycle for the sake of one error class.
 */

/** Accepted, dropped, and reported back. Changes style, not meaning. */
export const IGNORED = new Set([
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "user",
  "service_tier",
  "metadata",
  "store",
  "parallel_tool_calls",
  "prediction",
  // Tool DEFINITIONS. Refused until 1.2.0, on the reasoning that a caller waiting
  // for `tool_calls` would get prose instead. That reasoning assumed the caller had
  // no other way to get the work done. It does: an ACP agent has its own tools, and
  // can be handed the caller's own tool servers through `mcpServers` -- so it acts
  // rather than asks, and the work happens inside its loop instead of the caller's.
  //
  // The deciding case: a client whose ONLY model is an ACP agent. Refusing here left
  // it with no brain at all, which is a worse answer than a one-step loop. Tool
  // definitions are therefore dropped, while tool calls and results already in the
  // history are rendered faithfully -- see openai.js#toPromptBlocks.
  "tools",
  "tool_choice",
  "functions",
  "function_call",
]);

/**
 * Refused even when `unsupportedParams: "ignore"`. Each would silently change what
 * the response MEANS, and the caller has no way to notice.
 */
export const REFUSED = {
  response_format: "structured output is not implemented yet; it can only be emulated by prompting and validating",
  audio: "no ACP agent currently advertises the audio prompt capability",
  modalities: "text only",
  web_search_options: "the agent decides its own tool use",
  n: "one completion per request; a turn costs a real subscription, so fanning out is the caller's decision to make explicitly",
};

/** Honoured for real, by emulation rather than by passing them down. */
export const EMULATED = new Set(["max_tokens", "max_completion_tokens", "stop", "stream_options"]);

/** Fields this server implements natively. */
const NATIVE = new Set(["model", "messages", "stream"]);

/**
 * Splits a request body into what will be honoured and what will not.
 *
 * Unknown fields are treated as ignorable: OpenAI adds parameters faster than any
 * bridge tracks them, and failing on a field we simply have not heard of would age
 * badly. Anything genuinely dangerous is on the refused list by name.
 */
export function classify(body) {
  const ignored = [];
  const refused = [];
  for (const key of Object.keys(body)) {
    if (NATIVE.has(key) || EMULATED.has(key)) continue;
    // `n: 1` is what the caller would get anyway, so it is not worth a 400.
    if (key === "n" && (body.n === 1 || body.n == null)) continue;
    if (key in REFUSED) refused.push({ key, why: REFUSED[key] });
    else ignored.push(key);
  }
  return { ignored: ignored.sort(), refused };
}

/**
 * Remembers which (agent, parameter) pairs have already been logged.
 *
 * A warning per request would drown the log -- one client sending `temperature` in
 * a loop produces one line per call, forever. The interesting event is the first
 * one; after that it is noise about a configuration the operator already saw.
 */
export class ParamReporter {
  #seen = new Set();

  constructor(mode, log) {
    this.mode = mode;
    this.log = log;
  }

  /** Returns the ignored names to echo back, or throws when configured to refuse. */
  report(model, ignored) {
    if (this.mode === "ignore" || ignored.length === 0) return ignored;
    if (this.mode === "error") {
      const e = new Error(
        `unsupported parameter(s): ${ignored.join(", ")}. ACP cannot carry them; ` +
          `set server.unsupportedParams to "warn" to accept and ignore them instead`,
      );
      e.status = 400;
      e.code = "unsupported_parameter";
      throw e;
    }
    for (const key of ignored) {
      const id = `${model}:${key}`;
      if (this.#seen.has(id)) continue;
      this.#seen.add(id);
      this.log("warn", `${model}: ignoring "${key}" -- ACP cannot carry it (this is logged once per parameter)`);
    }
    return ignored;
  }
}
