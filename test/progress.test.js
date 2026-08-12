import { test } from "node:test";
import assert from "node:assert/strict";
import { Progress, tail, terminalResult } from "../src/progress.js";

/**
 * One Bash call, exactly as `claude-agent-acp` puts it on the wire -- captured
 * from a live agent on 2026-08-12. Six updates for one command, and the three
 * facts a reader needs are in three DIFFERENT ones: the command in the second,
 * the output in the fifth, the exit code in the sixth. This shape is the reason
 * `Progress` accumulates instead of reading each update on its own.
 */
const bashWire = (id, command, { output, exitCode }) => [
  { sessionUpdate: "tool_call", toolCallId: id, title: "Terminal", kind: "execute", status: "pending",
    rawInput: {}, content: [{ terminalId: id, type: "terminal" }], _meta: { terminal_info: { terminal_id: id } } },
  { sessionUpdate: "tool_call_update", toolCallId: id, title: command, kind: "execute", rawInput: { command } },
  { sessionUpdate: "tool_call_update", toolCallId: id, title: command, kind: "execute",
    rawInput: { command, description: "d" }, content: [{ terminalId: id, type: "terminal" }] },
  { sessionUpdate: "tool_call_update", toolCallId: id, _meta: { claudeCode: { toolResponse: { stdout: output } } } },
  { sessionUpdate: "tool_call_update", toolCallId: id, _meta: { terminal_output: { terminal_id: id, data: output } } },
  { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed",
    content: [{ terminalId: id, type: "terminal" }], _meta: { terminal_exit: { terminal_id: id, exit_code: exitCode, signal: null } } },
];

const replay = (p, updates) => updates.map((u) => p.note(u)).filter(Boolean).join("\n");

test("a real Bash call is named by its command, not by the placeholder it opens with", () => {
  const p = new Progress(2);
  const out = replay(p, bashWire("t1", "echo hi", { output: "motd\nnoise\nhi", exitCode: 0 }));
  // "Terminal" is what the adapter calls a command it has not finished streaming.
  assert.doesNotMatch(out, /Terminal/);
  assert.equal(out, "› echo hi\n⎿ noise\n⎿ hi");
});

test("a non-zero exit is reported, even though it arrives without any output", () => {
  const p = new Progress(1);
  const out = replay(p, bashWire("t2", "pytest -q", { output: "1 failed", exitCode: 1 }));
  assert.equal(out, "› pytest -q\n⎿ 1 failed\n✗ pytest -q (exit 1)");
});

test("a zero exit is not an error", () => {
  const p = new Progress(1);
  const out = replay(p, bashWire("t3", "ls", { output: "a", exitCode: 0 }));
  assert.doesNotMatch(out, /✗/, "marking a success would train the reader to ignore the mark");
});

test("a call is announced once, however many updates repeat it", () => {
  const p = new Progress(0);
  const out = replay(p, bashWire("t4", "make", { output: "ok", exitCode: 0 }));
  assert.equal(out.match(/› make/g).length, 1);
});

test("output lines are off when the budget is zero, but the command is still named", () => {
  const p = new Progress(0);
  assert.equal(replay(p, bashWire("t5", "ls", { output: "a\nb", exitCode: 0 })), "› ls");
});

test("a tool that arrives complete is announced immediately", () => {
  // Not everything streams its input. A call that already knows what it is doing
  // must not wait for a second update that may never come.
  const p = new Progress(0);
  const note = p.note({
    sessionUpdate: "tool_call", toolCallId: "r1", title: "Read a.ts", kind: "read",
    status: "pending", rawInput: { file_path: "a.ts" },
  });
  assert.equal(note, "› Read a.ts");
});

test("a call that never says what it is doing is still announced when it ends", () => {
  // The escape hatch: every call reaches a terminal status, so nothing can stay
  // unannounced forever.
  const p = new Progress(0);
  assert.equal(p.note({ sessionUpdate: "tool_call", toolCallId: "x1", title: "mystery", rawInput: {} }), null);
  assert.equal(p.note({ sessionUpdate: "tool_call_update", toolCallId: "x1", status: "failed" }), "› mystery\n✗ mystery");
});

test("a failed call with no name at all still reports the failure", () => {
  const p = new Progress(0);
  const out = replay(p, [
    { sessionUpdate: "tool_call", toolCallId: "n1", kind: "fetch", rawInput: { url: "x" } },
    { sessionUpdate: "tool_call_update", toolCallId: "n1", status: "failed" },
  ]);
  assert.equal(out, "› fetch\n✗ fetch");
});

test("a diff is measured, not pasted", () => {
  const p = new Progress(0);
  const note = p.note({
    sessionUpdate: "tool_call", toolCallId: "d1", title: "Edit x.ts", status: "completed",
    rawInput: { file_path: "x.ts" },
    content: [{ type: "diff", path: "x.ts", oldText: "a\nb\nc\n", newText: "a\nB1\nB2\nc\n" }],
  });
  assert.equal(note, "› Edit x.ts\n± x.ts +2/-1");
});

test("a new file counts every line as an addition", () => {
  const p = new Progress(0);
  const note = p.note({
    sessionUpdate: "tool_call", toolCallId: "d2", title: "Write new.ts", status: "completed",
    rawInput: { file_path: "new.ts" },
    content: [{ type: "diff", path: "new.ts", oldText: null, newText: "one\ntwo" }],
  });
  assert.match(note, /± new\.ts \+2\/-0/);
});

test("an unchanged plan summary says nothing the second time", () => {
  const p = new Progress(0);
  const plan = {
    sessionUpdate: "plan",
    entries: [{ content: "read", status: "completed" }, { content: "patch", status: "in_progress" }],
  };
  assert.equal(p.note(plan), "▸ plan 1/2 — patch");
  assert.equal(p.note({ ...plan, sessionUpdate: "plan_update" }), null);
  assert.equal(
    p.note({
      sessionUpdate: "plan_update",
      entries: [{ content: "read", status: "completed" }, { content: "patch", status: "completed" }],
    }),
    "▸ plan 2/2",
  );
});

test("an unrendered update kind returns null rather than throwing", () => {
  const p = new Progress(0);
  for (const u of [undefined, null, {}, { sessionUpdate: "usage_update" }, { sessionUpdate: "plan", entries: [] }]) {
    assert.equal(p.note(u), null);
  }
});

test("a title with a newline cannot break the shape of the trace", () => {
  const p = new Progress(0);
  const note = p.note({
    sessionUpdate: "tool_call", toolCallId: "w1", title: "Bash  echo one\necho two",
    status: "pending", rawInput: { command: "x" },
  });
  assert.equal(note, "› Bash echo one echo two");
});

test("the fenced console fallback is read when no _meta arrives", () => {
  // What the same agents send when the client does NOT advertise terminal_output.
  const p = new Progress(2);
  const out = replay(p, [
    { sessionUpdate: "tool_call", toolCallId: "f1", title: "npm test", rawInput: { command: "npm test" } },
    { sessionUpdate: "tool_call_update", toolCallId: "f1", status: "failed",
      content: [{ type: "content", content: { type: "text", text: "```console\nburied\nmore\n1 failed\n```" } }] },
  ]);
  assert.equal(out, "› npm test\n⎿ more\n⎿ 1 failed\n✗ npm test");
  assert.doesNotMatch(out, /buried/);
});

test("terminalResult reads output and exit code independently", () => {
  // They arrive in different updates; requiring both together reported every
  // command as successful.
  assert.deepEqual(terminalResult({ _meta: { terminal_exit: { exit_code: 2 } } }), { output: null, exitCode: 2 });
  assert.deepEqual(terminalResult({ _meta: { terminal_output: { data: "x" } } }), { output: "x", exitCode: null });
  assert.equal(terminalResult({ _meta: {} }), null);
});

test("the tail keeps the end, skips blank lines, and clips a long one", () => {
  assert.deepEqual(tail("a\n\nb\nc", 2), ["b", "c"]);
  assert.deepEqual(tail("a", 0), []);
  assert.ok(tail("x".repeat(500), 1)[0].length <= 160);
});
