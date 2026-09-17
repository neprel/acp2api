// npm install openai
import OpenAI from "openai";

const model = process.env.ACP2API_MODEL ?? "claude";
const client = new OpenAI({
  baseURL: process.env.ACP2API_BASE_URL ?? "http://127.0.0.1:10021/v1",
  apiKey: "local-not-used",
  timeout: 15 * 60_000,
  maxRetries: 0,
});

console.log("Chat Completions stream:");
const chat = await client.chat.completions.create({
  model,
  stream: true,
  messages: [{ role: "user", content: "Reply with one short greeting." }],
});
for await (const chunk of chat) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
process.stdout.write("\n\nResponses stream:\n");

const stream = client.responses.stream({ model, input: "Remember the number 41 and reply noted." });
for await (const event of stream) {
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
}
const first = await stream.finalResponse();
process.stdout.write("\n");

// Continuation is linear: always use the latest successful stored response id.
const second = await client.responses.create({
  model,
  previous_response_id: first.id,
  input: "What number did I ask you to remember?",
});
console.log("continued:", second.output_text);

const tools = [{
  type: "function",
  name: "weather",
  description: "Return weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
}];
const callResponse = await client.responses.create({
  model,
  input: process.env.ACP2API_TOOL_PROMPT ?? "Use the weather tool to get weather for Oslo.",
  tools,
});
const call = callResponse.output.find((item) => item.type === "function_call");
if (!call) throw new Error("agent did not call the weather tool");

const completed = await client.responses.create({
  model,
  previous_response_id: callResponse.id,
  tools,
  input: [{ type: "function_call_output", call_id: call.call_id, output: "clear, 12 C" }],
});
console.log("tool result:", completed.output_text);
