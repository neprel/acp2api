import { randomUUID } from "node:crypto";

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
  const rendered = messages.map((m) => {
    if (!m || typeof m !== "object" || typeof m.role !== "string") {
      throw new RequestError("each message needs a `role` and `content`");
    }
    return { role: m.role, text: contentToText(m.content, images) };
  });

  const system = rendered.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.text);
  const turns = rendered.filter((m) => m.role !== "system" && m.role !== "developer");
  if (turns.length === 0) throw new RequestError("`messages` needs at least one user or assistant message");

  const body =
    turns.length === 1
      ? turns[0].text
      : turns.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`).join("\n\n");

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
    } else {
      throw new RequestError(`unsupported content part type: ${part?.type}`);
    }
  }
  return out.join("");
}

/** Validates the request body and pulls out what this server actually honours. */
export function parseChatRequest(body) {
  if (!body || typeof body !== "object") throw new RequestError("request body must be a JSON object");
  if (typeof body.model !== "string" || body.model === "") throw new RequestError("`model` is required");
  return {
    model: body.model,
    blocks: toPromptBlocks(body.messages),
    stream: body.stream === true,
  };
}

/**
 * ACP reports cumulative session token counts, not per-turn ones. With a session
 * per request the two coincide, so they map straight across; `null` when the agent
 * omits usage (it is an unstable part of the spec and most agents do).
 */
function toUsage(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.thoughtTokens != null
      ? { completion_tokens_details: { reasoning_tokens: usage.thoughtTokens } }
      : {}),
  };
}

export const newCompletionId = () => `chatcmpl-${randomUUID().replace(/-/g, "")}`;

export function completion({ id, model, created, text, reasoning, stopReason, usage }) {
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
  };
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
