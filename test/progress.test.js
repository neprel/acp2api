import { test } from "node:test";
import assert from "node:assert/strict";
import { Progress } from "../src/progress.js";

const toolCall = (over = {}) => ({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", ...over });

test("a tool call is noted once, however many updates repeat it", () => {
  const p = new Progress();
  assert.equal(p.note(toolCall({ status: "pending" })), "› Read a.ts");
  assert.equal(p.note({ ...toolCall({ status: "in_progress" }), sessionUpdate: "tool_call_update" }), null);
  assert.equal(p.note({ ...toolCall({ status: "completed" }), sessionUpdate: "tool_call_update" }), null);
});

test("a failure is worth saying; a success is implied by the next line", () => {
  const ok = new Progress();
  ok.note(toolCall({ status: "pending" }));
  assert.equal(ok.note({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }), null);

  const bad = new Progress();
  bad.note(toolCall({ toolCallId: "t9", title: "Bash pytest", status: "pending" }));
  assert.equal(
    bad.note({ sessionUpdate: "tool_call_update", toolCallId: "t9", title: "Bash pytest", status: "failed" }),
    "✗ Bash pytest",
  );
});

test("a diff is measured, not pasted", () => {
  const p = new Progress();
  const note = p.note({
    sessionUpdate: "tool_call",
    toolCallId: "t2",
    title: "Edit x.ts",
    status: "completed",
    content: [{ type: "diff", path: "x.ts", oldText: "a\nb\nc\n", newText: "a\nB1\nB2\nc\n" }],
  });
  assert.equal(note, "› Edit x.ts\n± x.ts +2/-1");
});

test("a new file counts every line as an addition", () => {
  const p = new Progress();
  const note = p.note({
    sessionUpdate: "tool_call",
    toolCallId: "t3",
    title: "Write new.ts",
    status: "completed",
    content: [{ type: "diff", path: "new.ts", oldText: null, newText: "one\ntwo" }],
  });
  assert.match(note, /± new\.ts \+2\/-0/);
});

test("an unchanged plan summary says nothing the second time", () => {
  const p = new Progress();
  const plan = {
    sessionUpdate: "plan",
    entries: [
      { content: "read", status: "completed" },
      { content: "patch", status: "in_progress" },
    ],
  };
  assert.equal(p.note(plan), "▸ plan 1/2 — patch");
  // A plan_update fires per entry transition; most leave this line identical.
  assert.equal(p.note({ ...plan, sessionUpdate: "plan_update" }), null);
  assert.equal(
    p.note({
      sessionUpdate: "plan_update",
      entries: [
        { content: "read", status: "completed" },
        { content: "patch", status: "completed" },
      ],
    }),
    "▸ plan 2/2",
  );
});

test("an unrendered update kind returns null rather than throwing", () => {
  const p = new Progress();
  for (const u of [undefined, null, {}, { sessionUpdate: "usage_update" }, { sessionUpdate: "plan", entries: [] }]) {
    assert.equal(p.note(u), null);
  }
});

test("a title with a newline cannot break the shape of the trace", () => {
  const p = new Progress();
  assert.equal(p.note(toolCall({ title: "Bash  echo one\necho two", status: "pending" })), "› Bash echo one echo two");
});

test("a call with no title falls back to its kind", () => {
  const p = new Progress();
  assert.equal(p.note({ sessionUpdate: "tool_call", toolCallId: "t4", kind: "fetch", status: "pending" }), "› fetch");
});
