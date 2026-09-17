import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Tail, Terminals, WorkspacePaths } from "../src/terminal.js";

async function workspace(t) {
  const parent = await mkdtemp(join(tmpdir(), "acp2api-paths-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, outside, paths: new WorkspacePaths(root) };
}

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

test("ACP absolute paths inside the workspace are accepted", async (t) => {
  const { root, paths } = await workspace(t);
  const existing = join(root, "existing.txt");
  await writeFile(existing, "from ACP");

  assert.equal(paths.resolve(root, { directory: true }), paths.cwd);
  assert.equal(paths.resolve(existing), join(paths.cwd, "existing.txt"));
  assert.equal(await paths.readTextFile(existing), "from ACP");

  const directory = join(root, "terminal-cwd");
  await mkdir(directory);
  const terms = new Terminals({ cwd: root });
  const id = terms.create({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: directory,
  });
  await terms.waitForExit(id);
  assert.equal(terms.output(id).output, join(paths.cwd, "terminal-cwd"));
  terms.release(id);
});

test("workspace paths reject traversal and absolute paths outside the workspace", async (t) => {
  const { root, outside, paths } = await workspace(t);
  assert.throws(() => paths.resolve("../outside"), /traversal/);
  assert.throws(() => paths.resolve(`${root}${sep}nested${sep}..${sep}file`, { allowMissing: true }), /traversal/);
  assert.throws(() => paths.resolve(join(outside, "file"), { allowMissing: true }), /outside workspace/);
  assert.equal(paths.resolve("..name", { allowMissing: true }), join(paths.cwd, "..name"));
});

test("workspace paths reject file, directory, and broken symlinks", async (t) => {
  const { root, outside, paths } = await workspace(t);
  await writeFile(join(outside, "secret"), "secret");
  await symlink(join(outside, "secret"), join(root, "file-link"));
  await symlink(outside, join(root, "dir-link"));
  await symlink(join(outside, "missing"), join(root, "broken-link"));

  for (const path of ["file-link", "dir-link/secret", "broken-link"]) {
    assert.throws(() => paths.resolve(path, { allowMissing: true }), /symbolic links are not allowed/);
    assert.throws(() => paths.resolve(join(root, path), { allowMissing: true }), /symbolic links are not allowed/);
  }
  await assert.rejects(paths.readTextFile("file-link"), /symbolic links are not allowed/);
  await assert.rejects(paths.readTextFile(join(root, "file-link")), /symbolic links are not allowed/);
  await assert.rejects(paths.writeTextFile("dir-link/new", "nope"), /symbolic links are not allowed/);
  assert.equal(await readFile(join(outside, "secret"), "utf8"), "secret");
});

test("workspace writes validate existing parents and safely create new ones", async (t) => {
  const { root, paths } = await workspace(t);
  await mkdir(join(root, "existing"));
  await paths.writeTextFile("existing/new/child.txt", "ok");
  assert.equal(await paths.readTextFile("existing/new/child.txt"), "ok");

  await writeFile(join(root, "not-a-directory"), "x");
  await assert.rejects(paths.writeTextFile("not-a-directory/child", "nope"), /parent is not a directory/);
});

test("workspace writes create and overwrite files at the workspace root", async (t) => {
  const { root, paths } = await workspace(t);
  const relativeTarget = "new.txt";
  const absoluteTarget = join(root, "absolute.txt");

  await paths.writeTextFile(relativeTarget, "created");
  assert.equal(await readFile(join(root, relativeTarget), "utf8"), "created");
  await paths.writeTextFile(relativeTarget, "overwritten");
  assert.equal(await paths.readTextFile(relativeTarget), "overwritten");

  await paths.writeTextFile(absoluteTarget, "absolute");
  assert.equal(await paths.readTextFile(absoluteTarget), "absolute");
});

test("terminal cwd rejects symlinked directories even when they point inside", async (t) => {
  const { root } = await workspace(t);
  await mkdir(join(root, "real"));
  await symlink(join(root, "real"), join(root, "linked"));
  const terms = new Terminals({ cwd: root });
  assert.throws(
    () => terms.create({ command: process.execPath, args: ["-e", "0"], cwd: "linked" }),
    /symbolic links are not allowed/,
  );
});

test("the number of concurrent commands is bounded", () => {
  const terms = new Terminals({ cwd: process.cwd(), max: 1 });
  const id = terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  assert.throws(() => terms.create({ command: process.execPath, args: ["-e", "0"] }), /too many terminals/);
  terms.release(id);
});

test("finished commands do not consume the concurrent-command cap", async () => {
  const terms = new Terminals({ cwd: process.cwd(), max: 1 });
  const first = terms.create({ command: process.execPath, args: ["-e", "0"] });
  await terms.waitForExit(first);
  const second = terms.create({ command: process.execPath, args: ["-e", "0"] });
  assert.equal((await terms.waitForExit(second)).exitCode, 0);
  terms.releaseAll();
});

test("Terminals.create applies its output limit", async () => {
  const terms = new Terminals({ cwd: process.cwd(), outputByteLimit: 5 });
  const id = terms.create({ command: process.execPath, args: ["-e", "process.stdout.write('abcdefgh')"] });
  await terms.waitForExit(id);
  assert.deepEqual(terms.output(id), {
    output: "defgh",
    truncated: true,
    exitStatus: { exitCode: 0, signal: null },
  });
  terms.release(id);
});

test("Terminals.create applies its wall-clock timeout", async () => {
  const logs = [];
  const terms = new Terminals({ cwd: process.cwd(), timeoutMs: 25, log: (...args) => logs.push(args) });
  const id = terms.create({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  const exit = await terms.waitForExit(id);
  assert.equal(exit.signal, "SIGKILL");
  assert.ok(logs.some(([, message]) => message.includes("killed after 25ms")));
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
  assert.match(terms.output(id).output, /definitely-not-a-command/);
  assert.match(terms.output(id).output, /ENOENT/);
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
