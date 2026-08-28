import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolBridge } from "../src/mcp.js";
import { SessionStore } from "../src/sessions.js";

const TOOLS = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];

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
  await response;
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
