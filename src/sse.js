import { errorBody } from "./openai.js";

const RESPONSES_STREAM = Symbol("responsesStream");
const SSE_STATE = Symbol("sseState");

export const markResponsesStream = (res) => { res[RESPONSES_STREAM] = true; };
export const write = (res, payload) => writeSse(res, { payload });
export const writeResponseEvent = (res, payload) => writeSse(res, { event: payload.type, payload });
export const writeDone = (res) => writeSse(res, { done: true });

export function endSseError(res, message, code) {
  if (res[RESPONSES_STREAM]) {
    writeSse(res, { event: "error", payload: { type: "error", sequence_number: 0, code, message, param: null } });
  } else {
    write(res, errorBody(message, code));
  }
  writeDone(res);
  return endSse(res);
}

function writeSse(res, item) {
  let state = res[SSE_STATE];
  if (!state) {
    state = res[SSE_STATE] = { stalled: false, pending: [], ending: false, closed: false, responseSeq: 0 };
    res.once("close", () => {
      state.closed = true;
      state.pending.length = 0;
    });
  }
  if (state.closed) return;
  if (state.stalled) {
    const previous = state.pending.at(-1);
    if (!mergeSseDelta(previous, item)) state.pending.push(item);
    return;
  }
  if (!res.write(renderSse(state, item))) {
    state.stalled = true;
    res.once("drain", () => drainSse(res, state));
  }
}

function mergeSseDelta(previous, next) {
  if (!previous || previous.event !== next.event || previous.done || next.done) return false;
  let key;
  let before;
  let after;
  if (next.event) {
    if (
      !["response.output_text.delta", "response.reasoning_summary_text.delta"].includes(next.event) ||
      typeof previous.payload?.delta !== "string" || typeof next.payload?.delta !== "string" ||
      previous.payload.item_id !== next.payload.item_id ||
      previous.payload.output_index !== next.payload.output_index ||
      previous.payload.content_index !== next.payload.content_index ||
      previous.payload.summary_index !== next.payload.summary_index
    ) return false;
    key = "delta";
    before = previous.payload.delta;
    after = next.payload.delta;
  } else {
    const beforeDelta = previous.payload?.choices?.[0]?.delta;
    const afterDelta = next.payload?.choices?.[0]?.delta;
    key = typeof afterDelta?.content === "string" ? "content"
      : typeof afterDelta?.reasoning_content === "string" ? "reasoning_content" : null;
    if (!key || typeof beforeDelta?.[key] !== "string") return false;
    const other = key === "content" ? "reasoning_content" : "content";
    if (beforeDelta[other] != null || afterDelta[other] != null) return false;
    before = beforeDelta[key];
    after = afterDelta[key];
  }
  if (previous.coalesced && previous.coalesced.key !== key) return false;
  if (previous.coalesced) previous.coalesced.text += after;
  else previous.coalesced = { key, text: before + after };
  return true;
}

function renderSse(state, item) {
  if (item.done) return "data: [DONE]\n\n";
  let payload = item.payload;
  if (item.coalesced) {
    const text = item.coalesced.text;
    if (item.event) payload = { ...payload, delta: text };
    else {
      const choice = payload.choices[0];
      payload = { ...payload, choices: [{ ...choice, delta: { ...choice.delta, [item.coalesced.key]: text } }, ...payload.choices.slice(1)] };
    }
  }
  if (item.event && Number.isInteger(payload.sequence_number)) payload = { ...payload, sequence_number: state.responseSeq++ };
  return `${item.event ? `event: ${item.event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
}

function drainSse(res, state) {
  if (state.closed) return;
  state.stalled = false;
  while (state.pending.length > 0) {
    const item = state.pending.shift();
    if (!res.write(renderSse(state, item))) {
      state.stalled = true;
      res.once("drain", () => drainSse(res, state));
      return;
    }
  }
  if (state.ending) res.end();
}

export function endSse(res) {
  const state = res[SSE_STATE];
  if (!state || state.closed) return res.end();
  if (!state.stalled && state.pending.length === 0) return res.end();
  state.ending = true;
}

export function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
