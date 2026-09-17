/**
 * The OpenAI Responses API over ACP.
 *
 * This is the better fit of the two OpenAI surfaces, and not by a little: the
 * Responses API is stateful and so is ACP. `previous_response_id` maps onto a
 * retained session, `instructions` onto a system preamble, and `reasoning.effort`
 * straight onto the `thought_level` config option. Chat exposes the same ACP
 * override under its own `reasoning_effort` spelling.
 *
 * Pure translation, like openai.js: no I/O, no clock beyond what callers pass in.
 */
import { acp2apiAnnotation, RequestError, toPromptBlocks, toUsage } from "./openai.js";
import { ignoredNestedKeys, normalizeToolPolicy } from "./params.js";

/** Parameters that arrive under different names here than in chat completions. */
const NATIVE = new Set([
  "model",
  "input",
  "instructions",
  "previous_response_id",
  "store",
  "stream",
  "reasoning",
  "max_output_tokens",
  "tools",
  "tool_choice",
]);

const REFUSED = {
  text: "structured output is not implemented yet; it can only be emulated by prompting and validating",
  include: "there is nothing extra to include -- output items are always complete",
  truncation: "the agent manages its own context window",
};

/** ACP stop reasons -> Responses `status` and `incomplete_details.reason`. */
const STATUS = {
  end_turn: ["completed", null],
  max_tokens: ["incomplete", "max_output_tokens"],
  max_turn_requests: ["incomplete", "max_output_tokens"],
  refusal: ["incomplete", "content_filter"],
  cancelled: ["cancelled", null],
};

const EXACT_RESPONSE_STOP_REASONS = new Set(["end_turn", "max_tokens", "refusal", "cancelled"]);

/**
 * Renders `input` into ACP content blocks.
 *
 * `input` is either a bare string or the message array chat completions uses, so it
 * reuses the same renderer -- with one difference that matters: on a CONTINUED
 * response the session already holds the history, so only the new input is sent.
 * Replaying it would make the agent read its own past twice.
 */
export function toInputBlocks(input, instructions) {
  if (instructions != null && typeof instructions !== "string") {
    throw new RequestError("`instructions` must be a string or null");
  }
  const messages =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : Array.isArray(input)
        ? input.map((item) => normalizeItem(item)).filter(Boolean)
        : null;
  if (!messages) throw new RequestError("`input` must be a string or an array of items");
  // Every item was a tool answer: there is nothing to prompt with, and the caller
  // is resuming a turn rather than starting one. The handler checks for that first
  // and never gets here, so this is the guard for the case where it is wrong.
  if (messages.length === 0) return [];
  return toPromptBlocks(instructions ? [{ role: "system", content: instructions }, ...messages] : messages);
}

/** Accepts both `{role, content}` messages and typed input items. */
function normalizeItem(item) {
  if (!item || typeof item !== "object") throw new RequestError("each input item must be an object");
  // A call this server made, echoed back by the caller. It is part of the record
  // rather than something to say again -- the agent is still inside that call.
  if (item.type === "function_call") {
    if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) {
      throw new RequestError("a function_call input item needs non-empty `call_id` and `name`");
    }
    if (typeof item.arguments !== "string") throw new RequestError("function_call `arguments` must be a string");
    return null;
  }
  // The ANSWER to one. Read separately by `toolOutputsIn`; rendering it as a
  // message would tell the agent a person had pasted the result.
  if (item.type === "function_call_output") {
    if (typeof item.call_id !== "string" || !item.call_id) {
      throw new RequestError("a function_call_output input item needs a non-empty `call_id`");
    }
    if (!("output" in item)) throw new RequestError("a function_call_output input item needs `output`");
    return null;
  }
  if (item.type && item.type !== "message") {
    throw new RequestError(`input items of type "${item.type}" are not supported; send messages`);
  }
  const role = item.role ?? "user";
  if (!["user", "assistant", "system", "developer"].includes(role)) {
    throw new RequestError(`input message role "${role}" is not supported`);
  }
  if (typeof item.content !== "string" && !Array.isArray(item.content)) {
    throw new RequestError("input message `content` must be a string or an array of parts");
  }
  const content = Array.isArray(item.content) ? item.content.map(normalizeContentPart) : item.content;
  return { role, content };
}

/** Maps the supported Responses content vocabulary onto openai.js' ACP renderer. */
function normalizeContentPart(part) {
  if (!part || typeof part !== "object") throw new RequestError("each input content part must be an object");
  if (part.type === "input_text" || part.type === "output_text") {
    if (typeof part.text !== "string") throw new RequestError(`${part.type} \`text\` must be a string`);
    return { type: "text", text: part.text };
  }
  if (part.type === "input_image") {
    if (part.file_id != null) {
      throw new RequestError("input_image file_id refers to an OpenAI-hosted file; send a base64 data: URI instead");
    }
    if (typeof part.image_url !== "string" || !/^data:[^;,]+;base64,.+$/s.test(part.image_url)) {
      throw new RequestError("input_image image_url must be a base64 data: URI");
    }
    return { type: "image_url", image_url: { url: part.image_url } };
  }
  if (part.type === "input_file") {
    if (part.file_id != null) {
      throw new RequestError("input_file file_id refers to an OpenAI-hosted file; send file_data instead");
    }
    if (part.file_url != null) {
      throw new RequestError("remote input_file file_url is not fetched; send file_data instead");
    }
    return {
      type: "input_file",
      file_data: part.file_data,
      ...(part.filename != null ? { filename: part.filename } : {}),
    };
  }
  throw new RequestError(`unsupported input content part type: ${part.type}`);
}

export function parseResponsesRequest(body) {
  if (!body || typeof body !== "object") throw new RequestError("request body must be a JSON object");
  if (typeof body.model !== "string" || body.model === "") throw new RequestError("`model` is required");
  if (body.stream != null && typeof body.stream !== "boolean") throw new RequestError("`stream` must be a boolean");
  if (body.store != null && typeof body.store !== "boolean") throw new RequestError("`store` must be a boolean");
  if (body.previous_response_id != null && (typeof body.previous_response_id !== "string" || !body.previous_response_id)) {
    throw new RequestError("`previous_response_id` must be a non-empty string or null");
  }
  if (body.reasoning != null && (typeof body.reasoning !== "object" || Array.isArray(body.reasoning))) {
    throw new RequestError("`reasoning` must be an object");
  }
  if (body.reasoning?.effort != null && typeof body.reasoning.effort !== "string") {
    throw new RequestError("`reasoning.effort` must be a string or null");
  }
  if (body.tools != null && !Array.isArray(body.tools)) throw new RequestError("`tools` must be an array");

  const ignored = ignoredNestedKeys(body.reasoning, "reasoning", new Set(["effort"]));
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

  const inputBlocks = toInputBlocks(body.input);
  let toolPolicy;
  try {
    toolPolicy = normalizeToolPolicy(body, "responses");
  } catch (error) {
    throw error instanceof RequestError
      ? error
      : new RequestError(error.message, error.status ?? 400, error.code ?? "invalid_request_error");
  }

  return {
    model: body.model,
    // `blocks` is for a new chain; a continuation uses `inputBlocks` so unchanged
    // instructions are not reinserted into the stateful ACP history.
    blocks: toInputBlocks(body.input, body.instructions),
    inputBlocks,
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
    // The caller's own tools, and the answers it has sent back for calls this
    // server handed it. Same feature as on chat completions, different spelling:
    // Responses names a call `function_call` and its answer `function_call_output`.
    tools: toolPolicy.tools,
    toolChoice: toolPolicy.choice,
    toolsProvided: toolPolicy.toolsProvided,
    toolResults: toolOutputsIn(body.input),
  };
}

/** `function_call_output` items in an input array, as `{id, text}`. */
export function toolOutputsIn(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item?.type === "function_call_output")
    .map((item) => ({
      id: item.call_id,
      text: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
    }));
}

/** Builds the response object. `status` is derived from the ACP stop reason. */
export function responseObject({ id, model, created, text, reasoning, stopReason, usage, previousResponseId, instructions, store, ignored, calls, suspectedTextToolCall, context, cost, session }) {
  const [status, incomplete] = STATUS[stopReason] ?? ["completed", null];
  return {
    id,
    object: "response",
    created_at: created,
    status,
    model,
    output: canonicalOutputItems({ id, text, reasoning, calls }),
    output_text: text,
    instructions: instructions ?? null,
    previous_response_id: previousResponseId ?? null,
    store,
    incomplete_details: incomplete ? { reason: incomplete } : null,
    error: null,
    usage: renameUsage(usage),
    ...acp2apiAnnotation({
      ignored,
      suspectedTextToolCall,
      context,
      cost,
      session,
      stopReason: EXACT_RESPONSE_STOP_REASONS.has(stopReason) ? null : stopReason,
    }),
  };
}

/** The non-streamed ordering and item factories are also used by ResponseStream. */
function canonicalOutputItems({ id, text = "", reasoning = "", calls = [] }) {
  const items = [];
  if (reasoning) items.push(reasoningItem(itemId(id, "reasoning", items.length), reasoning));
  if (text || calls.length === 0) items.push(messageItem(itemId(id, "message", items.length), text));
  for (const call of calls) items.push(functionCallItem(itemId(id, "function_call", items.length), call));
  return items;
}

const itemId = (responseId, kind, outputIndex) =>
  `${responseId}-${kind === "reasoning" ? "rs" : kind === "message" ? "msg" : "fc"}-${outputIndex}`;

const reasoningItem = (id, text) => ({ id, type: "reasoning", summary: [{ type: "summary_text", text }] });
const messageItem = (id, text, status = "completed") => ({
  id,
  type: "message",
  status,
  role: "assistant",
  content: status === "in_progress" ? [] : [{ type: "output_text", text, annotations: [] }],
});
const functionCallItem = (id, call, status = "completed") => ({
  id,
  type: "function_call",
  status,
  call_id: call.call_id ?? call.id,
  name: call.name,
  arguments: status === "in_progress" ? "" : call.arguments,
});

/** Responses uses different field names; all arithmetic stays in `toUsage`. */
function renameUsage(usage) {
  const canonical = toUsage(usage);
  if (!canonical) return null;
  return {
    input_tokens: canonical.prompt_tokens,
    output_tokens: canonical.completion_tokens,
    total_tokens: canonical.total_tokens,
    ...(canonical.prompt_tokens_details ? { input_tokens_details: canonical.prompt_tokens_details } : {}),
    ...(canonical.completion_tokens_details ? { output_tokens_details: canonical.completion_tokens_details } : {}),
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
  #open = null;
  #items = [];

  constructor(write, { id, response }) {
    this.write = write;
    this.id = id;
    this.response = response;
  }

  #emit(type, payload) {
    this.write({ type, sequence_number: this.#seq++, ...payload });
  }

  created() {
    const initial = {
      ...this.response,
      status: "in_progress",
      output: [],
      output_text: "",
      incomplete_details: null,
      error: null,
      usage: null,
    };
    this.#emit("response.created", { response: initial });
    this.#emit("response.in_progress", { response: initial });
  }

  /** Opens the right item on demand, closing a different one first. */
  delta(kind, text) {
    if (this.#open?.kind !== kind) {
      this.#closeItem();
      const index = this.#index++;
      this.#open = { kind, index, id: itemId(this.id, kind, index), text: "" };
      const item =
        kind === "reasoning"
          ? { id: this.#open.id, type: "reasoning", summary: [] }
          : messageItem(this.#open.id, "", "in_progress");
      this.#emit("response.output_item.added", { output_index: this.#open.index, item });
      this.#emit(kind === "reasoning" ? "response.reasoning_summary_part.added" : "response.content_part.added", {
        item_id: item.id,
        output_index: this.#open.index,
        ...(kind === "reasoning" ? { summary_index: 0 } : { content_index: 0 }),
        part: kind === "reasoning" ? { type: "summary_text", text: "" } : { type: "output_text", text: "", annotations: [] },
      });
    }
    this.#open.text += text;
    this.#emit(kind === "reasoning" ? "response.reasoning_summary_text.delta" : "response.output_text.delta", {
      item_id: this.#open.id,
      output_index: this.#open.index,
      ...(kind === "reasoning" ? { summary_index: 0 } : { content_index: 0 }),
      delta: text,
    });
  }

  #closeItem() {
    if (!this.#open) return;
    const { kind, index, id, text } = this.#open;
    this.#emit(kind === "reasoning" ? "response.reasoning_summary_text.done" : "response.output_text.done", {
      item_id: id,
      output_index: index,
      ...(kind === "reasoning" ? { summary_index: 0 } : { content_index: 0 }),
      text,
    });
    this.#emit(kind === "reasoning" ? "response.reasoning_summary_part.done" : "response.content_part.done", {
      item_id: id,
      output_index: index,
      ...(kind === "reasoning" ? { summary_index: 0 } : { content_index: 0 }),
      part: kind === "reasoning" ? { type: "summary_text", text } : { type: "output_text", text, annotations: [] },
    });
    const item = kind === "reasoning" ? reasoningItem(id, text) : messageItem(id, text);
    this.#emit("response.output_item.done", { output_index: index, item });
    this.#items.push(item);
    this.#open = null;
  }

  /** Emits a complete function call even when ACP supplied its arguments at once. */
  functionCall(call) {
    this.#closeItem();
    const index = this.#index++;
    const id = itemId(this.id, "function_call", index);
    this.#emit("response.output_item.added", {
      output_index: index,
      item: functionCallItem(id, call, "in_progress"),
    });
    this.#emit("response.function_call_arguments.delta", {
      item_id: id,
      output_index: index,
      delta: call.arguments,
    });
    this.#emit("response.function_call_arguments.done", {
      item_id: id,
      output_index: index,
      arguments: call.arguments,
    });
    const item = functionCallItem(id, call);
    this.#emit("response.output_item.done", { output_index: index, item });
    this.#items.push(item);
  }

  finalize(response) {
    this.#closeItem();
    const calls = response.output.filter((item) => item.type === "function_call");
    for (const call of calls) this.functionCall(call);
    if (this.#items.length === 0) {
      for (const item of response.output) {
        if (item.type === "message") this.delta("message", item.content[0]?.text ?? "");
        else if (item.type === "reasoning") this.delta("reasoning", item.summary[0]?.text ?? "");
      }
      this.#closeItem();
    }
    const output = this.#items.map((item) => structuredClone(item));
    const outputText = output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content)
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("");
    return { ...structuredClone(response), output, output_text: outputText };
  }

  completed(response) {
    this.#emit(response.status === "incomplete" ? "response.incomplete" : "response.completed", { response });
  }

  failed(response) {
    this.#emit("response.failed", { response });
  }
}
