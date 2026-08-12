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

test("a command's own output is shown, from a fenced console block", () => {
  const p = new Progress(2);
  p.note({ sessionUpdate: "tool_call", toolCallId: "b1", title: "npm test", kind: "execute", status: "pending" });
  const note = p.note({
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    title: "npm test",
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "```console\nnoise\nmore\n1 failed\n```" } }],
  });
  // The END of the output: a build prints a thousand lines of progress and one
  // line of verdict.
  assert.equal(note, "⎿ more\n⎿ 1 failed\n✗ npm test");
});

test("a command's output is shown from _meta too, with its exit code", () => {
  const p = new Progress(4);
  const note = p.note({
    sessionUpdate: "tool_call",
    toolCallId: "b2",
    title: "make check",
    kind: "execute",
    status: "completed",
    content: [{ type: "terminal", terminalId: "b2" }],
    _meta: { terminal_output: { terminal_id: "b2", data: "checking\nall good\n" }, terminal_exit: { exit_code: 2 } },
  });
  assert.equal(note, "› make check\n⎿ checking\n⎿ all good\n✗ make check (exit 2)");
});

test("a zero exit code is not an error", () => {
  const p = new Progress(1);
  const note = p.note({
    sessionUpdate: "tool_call",
    toolCallId: "b3",
    title: "ls",
    status: "completed",
    _meta: { terminal_output: { data: "a\nb" }, terminal_exit: { exit_code: 0 } },
  });
  assert.equal(note, "› ls\n⎿ b");
});

test("output lines are off when the budget is zero", () => {
  const p = new Progress(0);
  const note = p.note({
    sessionUpdate: "tool_call",
    toolCallId: "b4",
    title: "ls",
    status: "completed",
    _meta: { terminal_output: { data: "a\nb" } },
  });
  assert.equal(note, "› ls", "the command is still named; only what it printed is withheld");
});

test("blank lines and a single very long line cannot blow up the trace", () => {
  const p = new Progress(3);
  const note = p.note({
    sessionUpdate: "tool_call",
    toolCallId: "b5",
    title: "build",
    status: "completed",
    _meta: { terminal_output: { data: `\n\n${"x".repeat(500)}\n\n` } },
  });
  const [, out] = note.split("\n");
  assert.ok(out.length <= 164, `expected a clipped line, got ${out.length} chars`);
});
