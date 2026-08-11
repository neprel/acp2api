import { randomUUID } from "node:crypto";
import { classify } from "./params.js";

/** ACP stop reasons -> OpenAI finish_reason. */
const FINISH = {
  end_turn: "stop",
  max_tokens: "length",
  max_turn_requests: "length",
  refusal: "content_filter",
  cancelled: "stop",
};

export class RequestError extends Error {
  constructor(message, status = 400, code = "invalid_request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Renders OpenAI `messages` into ACP content blocks.
 *
 * ACP sessions are stateful and a chat completion is not, so every request gets a
 * fresh session and the whole history in one prompt. A single user turn is passed
 * through verbatim -- the common case must not be wrapped in scaffolding the model
 * then has to see through. Multi-turn histories are rendered as a labelled
 * transcript, which is the only faithful option when the agent owns its own
 * conversation state and will not accept ours.
 */
export function toPromptBlocks(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RequestError("`messages` must be a non-empty array");
  }

  const images = [];
  // tool_call_id -> the name it was called with, so a result can say what it is
  // the result OF. The `role: "tool"` message carries only the id.
  const calledAs = new Map();

  const rendered = messages.map((m) => {
    if (!m || typeof m !== "object" || typeof m.role !== "string") {
      throw new RequestError("each message needs a `role` and `content`");
    }
    const text = contentToText(m.content, images);

    // An assistant turn that called tools has `content: null` and the calls in a
    // separate field. Rendered as text it was an empty "Assistant:" line -- the
    // agent saw a silent turn where work had happened.
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((c) => {
        const name = c?.function?.name ?? "tool";
        if (c?.id) calledAs.set(c.id, name);
        return `[calls ${name}] ${c?.function?.arguments ?? "{}"}`;
      });
      return { role: "assistant", text: [text, ...calls].filter(Boolean).join("\n") };
    }

    // A tool result is not something the USER said. Labelling it "User:" told the
    // agent a person had pasted the output, which is a different conversation.
    if (m.role === "tool") {
      const name = m.name ?? calledAs.get(m.tool_call_id) ?? "tool";
      return { role: "tool", text: `[result of ${name}]\n${text}` };
    }

    return { role: m.role, text };
  });

  const system = rendered.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.text);
  const turns = rendered.filter((m) => m.role !== "system" && m.role !== "developer");
  if (turns.length === 0) throw new RequestError("`messages` needs at least one user or assistant message");

  // Tool results carry their own marker, so labelling them again would read as a
  // speaker that does not exist.
  const speaker = (role) => (role === "tool" ? null : role === "assistant" ? "Assistant" : "User");
  const body =
    turns.length === 1 && turns[0].role === "user"
      ? turns[0].text
      : turns.map((m) => (speaker(m.role) ? `${speaker(m.role)}: ${m.text}` : m.text)).join("\n\n");

  const text = [...system, body].filter((s) => s.length > 0).join("\n\n");
  return [{ type: "text", text }, ...images];
}

/** Flattens an OpenAI content value, collecting image parts into `images`. */
function contentToText(content, images) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new RequestError("message `content` must be a string or an array of parts");

  const out = [];
  for (const part of content) {
    if (part?.type === "text") {
      out.push(part.text ?? "");
    } else if (part?.type === "image_url") {
      // Only data: URIs -- fetching a remote URL here would silently egress from
      // wherever this runs, which in this deployment is behind a VPN on purpose.
      const url = part.image_url?.url ?? "";
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (!m) throw new RequestError("image_url must be a base64 data: URI");
      images.push({ type: "image", mimeType: m[1], data: m[2] });
    } else if (part?.type === "file" || part?.type === "input_file") {
      images.push(toResource(part.file ?? part));
    } else {
      throw new RequestError(`unsupported content part type: ${part?.type}`);
    }
  }
  return out.join("");
}

/**
 * Turns an OpenAI file part into an ACP embedded resource.
 *
 * Both adapters advertise `embeddedContext: true`, so a file travels inside the
 * prompt rather than through an upload endpoint -- there is nothing to upload to.
 * Text is sent as text so the agent can actually read it; anything else goes as a
 * base64 blob and it is the agent's problem whether it understands the type.
 *
 * `file_id` is refused rather than ignored: it refers to an OpenAI-hosted file that
 * does not exist here, and silently dropping it would send a prompt that talks
 * about an attachment nobody attached.
 */
function toResource(file) {
  if (file?.file_id) throw new RequestError("file_id refers to an OpenAI-hosted file; send file_data instead");
  const data = file?.file_data ?? "";
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(data);
  if (!m) throw new RequestError("file_data must be a base64 data: URI");
  const [, mimeType, b64] = m;
  const uri = `file:///${file.filename ?? "attachment"}`;
  return mimeType.startsWith("text/") || mimeType === "application/json"
    ? { type: "resource", resource: { uri, mimeType, text: Buffer.from(b64, "base64").toString("utf8") } }
    : { type: "resource", resource: { uri, mimeType, blob: b64 } };
}

/** Validates the request body and pulls out what this server actually honours. */
export function parseChatRequest(body) {
  if (!body || typeof body !== "object") throw new RequestError("request body must be a JSON object");
  if (typeof body.model !== "string" || body.model === "") throw new RequestError("`model` is required");

  const { ignored, refused } = classify(body);
  if (refused.length > 0) {
    throw new RequestError(
      refused.map(({ key, why }) => `\`${key}\` is not supported: ${why}`).join("; "),
      400,
      "unsupported_parameter",
    );
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? null;
  if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw new RequestError("`max_tokens` must be a positive integer");
  }
  const stop = body.stop == null ? [] : Array.isArray(body.stop) ? body.stop : [body.stop];
  if (stop.some((s) => typeof s !== "string" || s === "")) {
    throw new RequestError("`stop` must be a non-empty string or an array of them");
  }

  return {
    model: body.model,
    blocks: toPromptBlocks(body.messages),
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    maxTokens,
    stop,
    ignored,
  };
}

/**
 * Rough token estimate: ~4 characters per token.
 *
 * There is no tokenizer here and there cannot be a correct one -- the agent picks
 * the model, and each family counts differently. This exists so `max_tokens` means
 * *something* rather than nothing; it is a budget, not an accountant.
 */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * Builds the `limit` callback the agent consults after each chunk, or null when the
 * request asks for no limits.
 *
 * `stop` and `max_tokens` are the two OpenAI knobs that can be honoured for real
 * without the protocol carrying them, because both are decidable from the output
 * alone: watch the text, and cut. Everything else in that family (`temperature`,
 * `top_p`, `seed`) shapes generation itself and has no client-side equivalent.
 */
export function makeLimiter({ maxTokens, stop }) {
  if (!maxTokens && (!stop || stop.length === 0)) return null;
  return (text) => {
    for (const needle of stop ?? []) {
      const at = text.indexOf(needle);
      // The stop sequence itself is not part of the answer, per OpenAI semantics.
      if (at >= 0) return { stopReason: "end_turn", text: text.slice(0, at) };
    }
    if (maxTokens && estimateTokens(text) > maxTokens) {
      return { stopReason: "max_tokens", text: text.slice(0, maxTokens * 4) };
    }
    return null;
  };
}

/** The ACP usage counters this bridge reads, and the shape `deltaUsage` returns. */
const USAGE_FIELDS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "thoughtTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
];

/**
 * Subtracts the session totals already reported from the ones just received.
 *
 * ACP usage counters are cumulative **across the session** -- "Total input tokens
 * across all turns" -- and a retained session now spans many requests, so passing
 * them straight through would report the whole conversation's spend as the cost of
 * its latest turn. Every consumer that sums responses would then count the first
 * turn once per turn that followed it.
 *
 * `before` is what the same session last reported, or nullish for its first turn.
 * A counter that went BACKWARDS is not clamped away silently -- it means the agent
 * reset or re-based its accounting, and the honest reading of a reset counter is
 * the counter itself, not a negative delta.
 */
export function deltaUsage(usage, before) {
  if (!usage) return null;
  const out = {};
  for (const f of USAGE_FIELDS) {
    const now = usage[f];
    if (now == null) continue;
    const prev = before?.[f] ?? 0;
    out[f] = now >= prev ? now - prev : now;
  }
  return out;
}

/**
 * One turn's counters in OpenAI's shape. `null` when the agent omits usage -- it is
 * an unstable part of the spec and most agents do.
 *
 * `cached_tokens` is the only evidence a caller ever gets that continuing a session
 * saved anything, so it is reported whenever the agent supplies it. It is a SUBSET
 * of `prompt_tokens` in OpenAI's model, not an addition to it.
 */
function toUsage(usage) {
  if (!usage) return null;
  const details = {};
  if (usage.cachedReadTokens != null) details.cached_tokens = usage.cachedReadTokens;
  if (usage.cachedWriteTokens != null) details.cache_creation_tokens = usage.cachedWriteTokens;
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(Object.keys(details).length > 0 ? { prompt_tokens_details: details } : {}),
    ...(usage.thoughtTokens != null
      ? { completion_tokens_details: { reasoning_tokens: usage.thoughtTokens } }
      : {}),
  };
}

export const newCompletionId = () => `chatcmpl-${randomUUID().replace(/-/g, "")}`;

export function completion({ id, model, created, text, reasoning, stopReason, usage, ignored }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          // Non-standard but the de-facto field (vLLM, DeepSeek, OpenRouter all use
          // it), and the reason for wiring agent_thought_chunk through at all.
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: FINISH[stopReason] ?? "stop",
      },
    ],
    ...(usage ? { usage: toUsage(usage) } : {}),
    // Non-standard, and safe: every client reads choices[0], so an extra key costs
    // nothing -- while silently dropping `temperature` and saying nothing would let
    // a caller believe a setting took effect that never could.
    ...(ignored?.length ? { x_acp2api: { ignored } } : {}),
  };
}

/**
 * The final frame of a stream when `stream_options.include_usage` is set: OpenAI
 * sends one extra chunk with an empty `choices` array carrying only usage.
 */
export function usageChunk({ id, model, created, usage }) {
  return { id, object: "chat.completion.chunk", created, model, choices: [], usage: toUsage(usage) };
}

export function chunk({ id, model, created, delta, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function errorBody(message, code, type = "invalid_request_error") {
  return { error: { message, type, code, param: null } };
}
