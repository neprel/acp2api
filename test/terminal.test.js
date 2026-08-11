import { test } from "node:test";
import assert from "node:assert/strict";
import { Tail, Terminals } from "../src/terminal.js";

test("the tail keeps the END of the output, which is the part that says what happened", () => {
  const tail = new Tail(10);
  tail.push(Buffer.from("0123456789"));
  assert.equal(tail.toString(), "0123456789");
  assert.equal(tail.truncated, false);

  tail.push(Buffer.from("abcde"));
  assert.equal(tail.toString(), "56789abcde");
  assert.equal(tail.truncated, true);
});

test("truncation never splits a character", () => {
  // Four bytes each; a byte-exact cut at 6 would land inside one and produce a
  // replacement character where a path or a name used to be.
  const tail = new Tail(6);
  tail.push(Buffer.from("💚💛💜"));
  const out = tail.toString();
  assert.ok(!out.includes("�"), `expected no replacement character, got ${JSON.stringify(out)}`);
  assert.equal(out, "💜");
});

test("a single write larger than the limit is cut inside itself", () => {
  const tail = new Tail(4);
  tail.push(Buffer.from("abcdefgh"));
  assert.equal(tail.toString(), "efgh");
});

test("a command runs, and its streams arrive interleaved as one terminal", async () => {
  const terms = new Terminals({ cwd: process.cwd() });
  const id = terms.create({
    command: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
  });
  await terms.waitForExit(id);
  const { output, exitStatus } = terms.output(id);
  assert.equal(exitStatus.exitCode, 0);
  assert.equal(output.length, 6, `expected both streams, got ${JSON.stringify(output)}`);
  terms.release(id);
  assert.equal(terms.size, 0);
});

test("output has no exitStatus while the command is still running", async () => {
  const terms = new Terminals({ cwd: process.cwd() });
  const id = terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  // The field's presence is what tells the agent the command finished.
  assert.equal(terms.output(id).exitStatus, undefined);
  terms.kill(id);
  await terms.waitForExit(id);
  assert.ok(terms.output(id).exitStatus, "and it appears once it has");
  terms.release(id);
});

test("a working directory outside the workspace is refused", () => {
  const terms = new Terminals({ cwd: process.cwd() });
  assert.throws(
    () => terms.create({ command: process.execPath, args: ["-e", "0"], cwd: "/" }),
    /outside workspace/,
  );
});

test("the number of concurrent commands is bounded", () => {
  const terms = new Terminals({ cwd: process.cwd(), max: 1 });
  const id = terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  assert.throws(() => terms.create({ command: process.execPath, args: ["-e", "0"] }), /too many terminals/);
  terms.release(id);
});

test("releasing a command that is still running kills it rather than orphaning it", async () => {
  const terms = new Terminals({ cwd: process.cwd() });
  const id = terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  const done = terms.waitForExit(id);
  terms.release(id);
  const exit = await done;
  assert.ok(exit.signal || exit.exitCode !== 0, `expected a killed process, got ${JSON.stringify(exit)}`);
});

test("a spawn failure settles instead of hanging whoever waits on it", async () => {
  // An agent waiting on exit would otherwise wait for the life of the session.
  const terms = new Terminals({ cwd: process.cwd() });
  const id = terms.create({ command: "/nonexistent/definitely-not-a-command" });
  const exit = await terms.waitForExit(id);
  assert.ok(exit, "expected the wait to settle");
  terms.release(id);
});

test("releaseAll reaps everything the agent left behind", async () => {
  const terms = new Terminals({ cwd: process.cwd() });
  const a = terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  const done = terms.waitForExit(a);
  terms.releaseAll();
  await done;
  assert.equal(terms.size, 0);
});
