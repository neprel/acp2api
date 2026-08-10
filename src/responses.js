/**
 * The OpenAI Responses API over ACP.
 *
 * This is the better fit of the two OpenAI surfaces, and not by a little: the
 * Responses API is stateful and so is ACP. `previous_response_id` maps onto a
 * retained session, `instructions` onto a system preamble, and `reasoning.effort`
 * straight onto the `thought_level` config option -- a per-request knob chat
 * completions cannot express at all, because it has no field for it.
 *
 * Pure translation, like openai.js: no I/O, no clock beyond what callers pass in.
 */
import { RequestError, toPromptBlocks } from "./openai.js";

/** Parameters that arrive under different names here than in chat completions. */
const NATIVE = new Set(["model", "input", "instructions", "previous_response_id", "store", "stream", "reasoning", "max_output_tokens"]);

const REFUSED = {
  tools: "the agent runs its own tool loop and cannot return tool calls; give it tools with `mcpServers` in the agent config instead",
  tool_choice: "see `tools`",
  text: "structured output is not implemented yet; it can only be emulated by prompting and validating",
  include: "there is nothing extra to include -- output items are always complete",
  truncation: "the agent manages its own context window",
};

/** ACP stop reasons -> Responses `status` and `incomplete_details.reason`. */
const STATUS = {
  end_turn: ["completed", null],
  max_tokens: ["incomplete", "max_output_tokens"],
  max_turn_requests: ["incomplete", "max_output_tokens"],
  refusal: ["completed", null],
  cancelled: ["incomplete", "cancelled"],
};

/**
 * Renders `input` into ACP content blocks.
 *
 * `input` is either a bare string or the message array chat completions uses, so it
 * reuses the same renderer -- with one difference that matters: on a CONTINUED
 * response the session already holds the history, so only the new input is sent.
 * Replaying it would make the agent read its own past twice.
 */
export function toInputBlocks(input, instructions) {
  const messages =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : Array.isArray(input)
        ? input.map((item) => normalizeItem(item))
        : null;
  if (!messages) throw new RequestError("`input` must be a string or an array of items");
  return toPromptBlocks(instructions ? [{ role: "system", content: instructions }, ...messages] : messages);
}

/** Accepts both `{role, content}` messages and typed input items. */
function normalizeItem(item) {
  if (!item || typeof item !== "object") throw new RequestError("each input item must be an object");
  if (item.type && item.type !== "message") {
    throw new RequestError(`input items of type "${item.type}" are not supported; send messages`);
  }
  const content = Array.isArray(item.content)
    ? item.content.map((p) => (p?.type === "input_text" ? { type: "text", text: p.text } : p))
    : item.content;
  return { role: item.role ?? "user", content };
}

export function parseResponsesRequest(body) {
  if (!body || typeof body !== "object") throw new RequestError("request body must be a JSON object");
  if (typeof body.model !== "string" || body.model === "") throw new RequestError("`model` is required");

  const ignored = [];
  const refused = [];
  for (const key of Object.keys(body)) {
    if (NATIVE.has(key)) continue;
    if (key in REFUSED) refused.push({ key, why: REFUSED[key] });
    else ignored.push(key);
  }
  if (refused.length > 0) {
    throw new RequestError(
      refused.map(({ key, why }) => `\`${key}\` is not supported: ${why}`).join("; "),
      400,
      "unsupported_parameter",
    );
  }

  const maxTokens = body.max_output_tokens ?? null;
  if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw new RequestError("`max_output_tokens` must be a positive integer");
  }

  return {
    model: body.model,
    blocks: toInputBlocks(body.input, body.instructions),
    instructions: body.instructions ?? null,
    previousResponseId: body.previous_response_id ?? null,
    // OpenAI stores by default, and so do we: without retention
    // `previous_response_id` could never be satisfied.
    store: body.store !== false,
    stream: body.stream === true,
    // The one genuinely per-request agent setting ACP can carry.
    reasoning: body.reasoning?.effort ?? null,
    maxTokens,
    stop: [],
    ignored: ignored.sort(),
  };
}

/** Builds the response object. `status` is derived from the ACP stop reason. */
export function responseObject({ id, model, created, text, reasoning, stopReason, usage, previousResponseId, instructions, store, ignored }) {
  const [status, incomplete] = STATUS[stopReason] ?? ["completed", null];
  return {
    id,
    object: "response",
    created_at: created,
    status,
    model,
    output: [
      ...(reasoning
        ? [{ id: `${id}-rs`, type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] }]
        : []),
      {
        id: `${id}-msg`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    instructions: instructions ?? null,
    previous_response_id: previousResponseId ?? null,
    store,
    incomplete_details: incomplete ? { reason: incomplete } : null,
    error: null,
    usage: usage
      ? {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          ...(usage.thoughtTokens != null ? { output_tokens_details: { reasoning_tokens: usage.thoughtTokens } } : {}),
        }
      : null,
    ...(ignored?.length ? { x_acp2api: { ignored } } : {}),
  };
}

/**
 * Emits the Responses event stream.
 *
 * Unlike chat completions, these events are typed and ORDERED: an item must be
 * added before its parts, and closed after them. A consumer that tracks
 * `output_index` breaks on a stray delta, so the sequencing here is the contract --
 * hence one object owning it rather than writes scattered through the handler.
 */
export class ResponseStream {
  #seq = 0;
  #index = 0;
  #open = null; // {kind: "reasoning"|"message", index}

  constructor(write, { id, response }) {
    this.write = write;
    this.id = id;
    this.response = response;
  }

  #emit(type, payload) {
    this.write({ type, sequence_number: this.#seq++, ...payload });
  }

  created() {
    this.#emit("response.created", { response: this.response });
    this.#emit("response.in_progress", { response: this.response });
  }

  /** Opens the right item on demand, closing a different one first. */
  delta(kind, text) {
    if (this.#open?.kind !== kind) {
      this.#closeItem();
      this.#open = { kind, index: this.#index++, text: "" };
      const item =
        kind === "reasoning"
          ? { id: `${this.id}-rs`, type: "reasoning", summary: [] }
          : { id: `${this.id}-msg`, type: "message", status: "in_progress", role: "assistant", content: [] };
      this.#emit("response.output_item.added", { output_index: this.#open.index, item });
      this.#emit("response.content_part.added", {
        item_id: item.id,
        output_index: this.#open.index,
        content_index: 0,
        part: kind === "reasoning" ? { type: "summary_text", text: "" } : { type: "output_text", text: "", annotations: [] },
      });
    }
    this.#open.text += text;
    this.#emit(kind === "reasoning" ? "response.reasoning_summary_text.delta" : "response.output_text.delta", {
      item_id: `${this.id}-${kind === "reasoning" ? "rs" : "msg"}`,
      output_index: this.#open.index,
      content_index: 0,
      delta: text,
    });
  }

  #closeItem() {
    if (!this.#open) return;
    const { kind, index, text } = this.#open;
    const itemId = `${this.id}-${kind === "reasoning" ? "rs" : "msg"}`;
    this.#emit(kind === "reasoning" ? "response.reasoning_summary_text.done" : "response.output_text.done", {
      item_id: itemId,
      output_index: index,
      content_index: 0,
      text,
    });
    this.#emit("response.content_part.done", {
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part:
        kind === "reasoning"
          ? { type: "summary_text", text }
          : { type: "output_text", text, annotations: [] },
    });
    this.#emit("response.output_item.done", {
      output_index: index,
      item:
        kind === "reasoning"
          ? { id: itemId, type: "reasoning", summary: [{ type: "summary_text", text }] }
          : {
              id: itemId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
    });
    this.#open = null;
  }

  completed(response) {
    this.#closeItem();
    this.#emit(response.status === "incomplete" ? "response.incomplete" : "response.completed", { response });
  }

  failed(response) {
    this.#closeItem();
    this.#emit("response.failed", { response });
  }
}
