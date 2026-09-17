import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolBridge, toMcpTool, toolFingerprint } from "../src/mcp.js";
import { SessionStore } from "../src/sessions.js";

const TOOLS = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];

test("only validated function tools are converted to MCP", () => {
  assert.deepEqual(toMcpTool(TOOLS[0]), {
    name: "read_file",
    description: "",
    inputSchema: { type: "object" },
  });
  assert.deepEqual(toMcpTool({ type: "function", name: "flat" }), {
    name: "flat",
    description: "",
    inputSchema: { type: "object", properties: {} },
  });
  assert.throws(() => toMcpTool({ type: "custom", name: "unsafe" }), /invalid OpenAI function tool/);
});

test("a conversation rejects changes to its cached tool list", () => {
  const bridge = new ToolBridge();
  const token = bridge.open(TOOLS);
  bridge.setTools(token, structuredClone(TOOLS));
  assert.throws(
    () => bridge.setTools(token, [{ type: "function", function: { name: "write_file" } }]),
    (error) => error.status === 400 && error.code === "tool_set_changed",
  );
  bridge.close(token);
});

test("tool fingerprints ignore object-key and tool order but retain schema changes", () => {
  const a = [
    { type: "function", function: { name: "b", parameters: { type: "object", properties: { x: { type: "string" } } } } },
    { type: "function", function: { name: "a" } },
  ];
  const b = [
    { function: { name: "a" }, type: "function" },
    { function: { parameters: { properties: { x: { type: "string" } }, type: "object" }, name: "b" }, type: "function" },
  ];
  assert.equal(toolFingerprint(a), toolFingerprint(b));
  b[1].function.parameters.properties.x.type = "number";
  assert.notEqual(toolFingerprint(a), toolFingerprint(b));
});

test("tool_choice none disables both discovery and stale cached calls, and auto re-enables them", async () => {
  const bridge = new ToolBridge();
  const token = bridge.open(TOOLS);
  bridge.setEnabled(token, false);
  assert.deepEqual(
    await bridge.handle(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    { jsonrpc: "2.0", id: 1, result: { tools: [] } },
  );
  const refused = await bridge.handle(token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "read_file", arguments: {} },
  });
  assert.equal(refused.error.code, -32602);
  bridge.setEnabled(token, true);
  assert.equal((await bridge.handle(token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).result.tools.length, 1);
  bridge.close(token);
});

async function parked(bridge, token, convId) {
  const response = bridge.handle(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_file", arguments: { path: "README.md" } },
  });
  await bridge.nextPark(token);
  const [call] = bridge.parked(token);
  bridge.reported(token, [call.id], convId);
  return { call, response };
}

function storeFor(bridge) {
  return new SessionStore({
    onPendingClear: (convId) => bridge.releaseConversation(convId),
    onClose: (conv) => conv.bench && bridge.close(conv.bench),
  });
}

async function withLiveLoop(promise, ms = 1_000) {
  // The park deadline is deliberately unref'd; the test must hold the loop open itself.
  const keepAlive = setTimeout(() => {}, ms);
  try {
    return await promise;
  } finally {
    clearTimeout(keepAlive);
  }
}

test("a handed-over call id exists only until resume consumes it", async () => {
  const bridge = new ToolBridge();
  const token = bridge.open(TOOLS);
  const { call, response } = await parked(bridge, token, "conv-resume");
  assert.equal(bridge.conversation(call.id), "conv-resume");
  assert.equal(bridge.resolve(token, call.id, "done"), true);
  await response;
  assert.equal(bridge.conversation(call.id), null);
});

test("an unanswered call id disappears at its own deadline", async () => {
  const bridge = new ToolBridge({ timeoutMs: 5 });
  const token = bridge.open(TOOLS);
  const { call, response } = await parked(bridge, token, "conv-timeout");
  assert.equal(bridge.conversation(call.id), "conv-timeout");
  await withLiveLoop(response);
  assert.equal(bridge.conversation(call.id), null);
});

test("an unattended settled pending turn releases every indexed call id", async () => {
  const bridge = new ToolBridge();
  const sessions = storeFor(bridge);
  const token = bridge.open(TOOLS);
  const convId = sessions.open("fake", null, { bench: token });
  const { call } = await parked(bridge, token, convId);
  let settle;
  const turn = new Promise((resolve) => (settle = resolve));
  sessions.setPending(convId, { turn, attached: false });
  settle({});
  await turn;
  await Promise.resolve();
  assert.equal(bridge.conversation(call.id), null);
  bridge.close(token);
});

test("discarding a pending conversation removes its indexed call ids", async () => {
  const bridge = new ToolBridge();
  const sessions = storeFor(bridge);
  const token = bridge.open(TOOLS);
  const convId = sessions.open("fake", null, { bench: token });
  const { call, response } = await parked(bridge, token, convId);
  sessions.setPending(convId, { turn: new Promise(() => {}), attached: false });
  await sessions.discard(convId);
  await response;
  assert.equal(bridge.conversation(call.id), null);
});

test("closing the store removes indexed ids before conversations disappear", async () => {
  const bridge = new ToolBridge();
  const sessions = storeFor(bridge);
  const token = bridge.open(TOOLS);
  const convId = sessions.open("fake", null, { bench: token });
  const { call, response } = await parked(bridge, token, convId);
  sessions.setPending(convId, { turn: new Promise(() => {}), attached: false });
  await sessions.closeAll();
  await response;
  assert.equal(bridge.conversation(call.id), null);
});

test("retiring a dead pending session cannot leave a resolvable call id", async () => {
  const bridge = new ToolBridge();
  const sessions = storeFor(bridge);
  const token = bridge.open(TOOLS);
  const convId = sessions.open("fake", { id: "s1", dead: true }, { bench: token });
  const { call, response } = await parked(bridge, token, convId);
  sessions.setPending(convId, { turn: new Promise(() => {}), attached: false });
  await sessions.discard(convId);
  await response;
  assert.equal(bridge.conversation(call.id), null);
});
