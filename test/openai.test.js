import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, completion, deltaUsage, parseChatRequest, RequestError, toPromptBlocks } from "../src/openai.js";

test("a single user turn is passed through with no scaffolding", () => {
  assert.deepEqual(toPromptBlocks([{ role: "user", content: "hi" }]), [{ type: "text", text: "hi" }]);
});

test("system messages are prepended, not labelled", () => {
  const [block] = toPromptBlocks([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(block.text, "be terse\n\nhi");
});

test("multi-turn history becomes a labelled transcript", () => {
  const [block] = toPromptBlocks([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  assert.equal(block.text, "User: one\n\nAssistant: two\n\nUser: three");
});

test("developer messages are treated as system", () => {
  const [block] = toPromptBlocks([
    { role: "developer", content: "rules" },
    { role: "user", content: "go" },
  ]);
  assert.equal(block.text, "rules\n\ngo");
});

test("content part arrays flatten, data: images become image blocks", () => {
  const blocks = toPromptBlocks([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this? " },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    },
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "what is this? " },
    { type: "image", mimeType: "image/png", data: "QUJD" },
  ]);
});

test("an assistant turn that called tools renders the calls, not an empty line", () => {
  const [block] = toPromptBlocks([
    { role: "user", content: "fix the bug" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "line one" },
    { role: "assistant", content: "found it" },
  ]);
  assert.equal(
    block.text,
    [
      "User: fix the bug",
      "",
      'Assistant: [calls read_file] {"path":"a.js"}',
      "",
      "[result of read_file]\nline one",
      "",
      "Assistant: found it",
    ].join("\n"),
  );
});

test("a tool result is attributed to the tool, never to the user", () => {
  // Labelling it "User:" told the agent a person had pasted the output, which is a
  // different conversation from the one that happened.
  const [block] = toPromptBlocks([
    { role: "user", content: "go" },
    { role: "tool", tool_call_id: "unknown", name: "recall", content: "a fact" },
  ]);
  assert.match(block.text, /\[result of recall\]\na fact/);
  assert.ok(!block.text.includes("User: a fact"));
});

test("an assistant turn with both text and calls keeps both", () => {
  const [block] = toPromptBlocks([
    { role: "user", content: "go" },
    { role: "assistant", content: "reading it now", tool_calls: [{ id: "c", function: { name: "ls" } }] },
  ]);
  assert.match(block.text, /Assistant: reading it now\n\[calls ls\] \{\}/);
});

test("file parts become ACP resource blocks, text inline and binary as blob", () => {
  const text = Buffer.from("hello file").toString("base64");
  const [, res] = toPromptBlocks([
    {
      role: "user",
      content: [
        { type: "text", text: "summarise" },
        { type: "file", file: { filename: "a.txt", file_data: `data:text/plain;base64,${text}` } },
      ],
    },
  ]);
  // Text arrives as text so the agent can actually read it, not as an opaque blob.
  assert.deepEqual(res, {
    type: "resource",
    resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "hello file" },
  });

  const [, pdf] = toPromptBlocks([
    { role: "user", content: [{ type: "input_file", file_data: "data:application/pdf;base64,QUJD", filename: "b.pdf" }] },
  ]);
  assert.deepEqual(pdf.resource, { uri: "file:///b.pdf", mimeType: "application/pdf", blob: "QUJD" });
});

test("file_id is refused rather than silently dropped", () => {
  // Dropping it would send a prompt that talks about an attachment nobody attached.
  assert.throws(
    () => toPromptBlocks([{ role: "user", content: [{ type: "file", file: { file_id: "file-abc" } }] }]),
    /file_id refers to an OpenAI-hosted file/,
  );
});

test("a remote image URL is refused rather than fetched", () => {
  assert.throws(
    () => toPromptBlocks([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }]),
    /base64 data: URI/,
  );
});

test("malformed requests are rejected", () => {
  assert.throws(() => toPromptBlocks([]), RequestError);
  assert.throws(() => toPromptBlocks([{ role: "system", content: "only" }]), /at least one user or assistant/);
  assert.throws(() => toPromptBlocks([{ content: "no role" }]), /role/);
  assert.throws(() => parseChatRequest({ messages: [{ role: "user", content: "x" }] }), /`model` is required/);
  assert.throws(() => parseChatRequest("nope"), /JSON object/);
});

test("parseChatRequest surfaces the stream flag", () => {
  const base = { model: "m", messages: [{ role: "user", content: "x" }] };
  assert.equal(parseChatRequest(base).stream, false);
  assert.equal(parseChatRequest({ ...base, stream: true }).stream, true);
});

test("completion maps stop reasons and carries reasoning separately", () => {
  const meta = { id: "c1", model: "m", created: 7 };
  const c = completion({ ...meta, text: "out", reasoning: "why", stopReason: "end_turn", usage: null });
  assert.equal(c.choices[0].finish_reason, "stop");
  assert.equal(c.choices[0].message.content, "out");
  assert.equal(c.choices[0].message.reasoning_content, "why");
  assert.equal(c.usage, undefined);

  assert.equal(completion({ ...meta, text: "", stopReason: "max_tokens" }).choices[0].finish_reason, "length");
  assert.equal(completion({ ...meta, text: "", stopReason: "refusal" }).choices[0].finish_reason, "content_filter");
  // An unknown future stop reason must not produce an invalid finish_reason.
  assert.equal(completion({ ...meta, text: "", stopReason: "something_new" }).choices[0].finish_reason, "stop");
  // No reasoning means no field at all, not an empty string.
  assert.ok(!("reasoning_content" in completion({ ...meta, text: "x", reasoning: "", stopReason: "end_turn" }).choices[0].message));
});

test("usage maps ACP token counts to OpenAI names", () => {
  const c = completion({
    id: "c1",
    model: "m",
    created: 7,
    text: "x",
    stopReason: "end_turn",
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, thoughtTokens: 3 },
  });
  assert.deepEqual(c.usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
    completion_tokens_details: { reasoning_tokens: 3 },
  });
});

test("cache counters map onto prompt_tokens_details", () => {
  const c = completion({
    id: "c1",
    model: "m",
    created: 7,
    text: "x",
    stopReason: "end_turn",
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, cachedReadTokens: 9, cachedWriteTokens: 2 },
  });
  // A subset of prompt_tokens in OpenAI's model, not an addition to it.
  assert.deepEqual(c.usage.prompt_tokens_details, { cached_tokens: 9, cache_creation_tokens: 2 });
  assert.equal(c.usage.prompt_tokens, 11);
});

test("deltaUsage subtracts the totals a session already reported", () => {
  const before = { inputTokens: 11, outputTokens: 22, totalTokens: 33, cachedReadTokens: 0 };
  const now = { inputTokens: 22, outputTokens: 44, totalTokens: 66, cachedReadTokens: 10 };
  assert.deepEqual(deltaUsage(now, before), {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    cachedReadTokens: 10,
  });
});

test("deltaUsage on a first turn reports the counters as they arrived", () => {
  const now = { inputTokens: 11, outputTokens: 22, totalTokens: 33 };
  assert.deepEqual(deltaUsage(now, null), now);
  assert.equal(deltaUsage(null, null), null);
});

test("a counter that went backwards is read as a reset, not as a negative turn", () => {
  // An agent that re-bases its own accounting mid-session would otherwise produce
  // a negative token count, which no consumer can do anything sensible with.
  const before = { inputTokens: 100, outputTokens: 200, totalTokens: 300 };
  const now = { inputTokens: 5, outputTokens: 6, totalTokens: 11 };
  assert.deepEqual(deltaUsage(now, before), now);
});

test("deltaUsage carries no field the agent did not report", () => {
  const d = deltaUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 7 }, null);
  assert.deepEqual(Object.keys(d).sort(), ["inputTokens", "outputTokens", "totalTokens"]);
});

test("chunk is a well-formed streaming delta", () => {
  const c = chunk({ id: "c1", model: "m", created: 7, delta: { content: "a" } });
  assert.equal(c.object, "chat.completion.chunk");
  assert.deepEqual(c.choices[0], { index: 0, delta: { content: "a" }, finish_reason: null });
});
