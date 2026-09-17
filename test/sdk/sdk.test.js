import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { Agent } from "../../src/agent.js";
import { normalizeConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "fake-agent.js");

async function clientFor(t) {
  const config = normalizeConfig(
    {
      server: { host: "127.0.0.1", cwd: here },
      agents: [{ name: "fake", type: "general", command: process.execPath, args: [FIXTURE] }],
    },
    { baseDir: here, env: {} },
  );
  const server = createServer(config, {
    agents: new Map(config.agents.map((spec) => [spec.name, new Agent(spec, config.server)])),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return new OpenAI({
    apiKey: "offline-test-key",
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    maxRetries: 0,
    timeout: 10_000,
  });
}

test("official OpenAI SDK consumes Chat Completions non-streaming and streaming", async (t) => {
  const client = await clientFor(t);
  const completion = await client.chat.completions.create({
    model: "fake",
    messages: [{ role: "user", content: "sdk chat" }],
  });
  assert.equal(completion.choices[0].message.content, "[fast] sdk chat");

  const stream = await client.chat.completions.create({
    model: "fake",
    messages: [{ role: "user", content: "sdk chat stream" }],
    stream: true,
  });
  let text = "";
  let finishReason = null;
  for await (const event of stream) {
    text += event.choices[0]?.delta?.content ?? "";
    finishReason = event.choices[0]?.finish_reason ?? finishReason;
  }
  assert.equal(text, "[fast] sdk chat stream");
  assert.equal(finishReason, "stop");
});

test("official OpenAI SDK consumes Responses create and stream/finalResponse", async (t) => {
  const client = await clientFor(t);
  const response = await client.responses.create({ model: "fake", input: "sdk response" });
  assert.equal(response.output_text, "[fast] sdk response");
  assert.equal(response.status, "completed");

  const stream = client.responses.stream({ model: "fake", input: "sdk response stream" });
  const types = [];
  for await (const event of stream) types.push(event.type);
  const final = await stream.finalResponse();
  assert.equal(final.output_text, "[fast] sdk response stream");
  assert.equal(final.status, "completed");
  assert.ok(types.includes("response.output_text.delta"));
  assert.equal(types.at(-1), "response.completed");
});

test("official OpenAI SDK accepts inline Responses files and refusal status", async (t) => {
  const client = await clientFor(t);
  const withFile = await client.responses.create({
    model: "fake",
    input: [{ role: "user", content: [
      { type: "input_text", text: "sdk inline file" },
      { type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,aGk=" },
    ] }],
  });
  assert.equal(withFile.status, "completed");
  assert.equal(withFile.output_text, "[fast] sdk inline file[resource]");

  const refusal = await client.responses.create({ model: "fake", input: "REFUSE" });
  assert.equal(refusal.status, "incomplete");
  assert.equal(refusal.incomplete_details?.reason, "content_filter");
});

test("official OpenAI SDK accumulates and resumes a Responses function call", async (t) => {
  const client = await clientFor(t);
  const tools = [{
    type: "function",
    name: "read_file",
    description: "Read one file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }];
  const stream = client.responses.stream({
    model: "fake",
    input: 'USETOOL read_file {"path":"README.md"}',
    tools,
  });
  const events = [];
  for await (const event of stream) events.push(event);
  const first = await stream.finalResponse();
  const call = first.output.find((item) => item.type === "function_call");
  assert.ok(call);
  assert.equal(call.name, "read_file");
  assert.deepEqual(JSON.parse(call.arguments), { path: "README.md" });
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.delta"));
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.done"));

  const second = await client.responses.create({
    model: "fake",
    previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: "the SDK supplied this result" }],
    tools,
  });
  assert.match(second.output_text, /RESULT:the SDK supplied this result/);
  assert.equal(second.status, "completed");
});
