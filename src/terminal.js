import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Commands the agent runs, executed here instead of inside it.
 *
 * ACP lets a client offer `terminal/*`, and an agent that sees the capability
 * routes its shell work through the client rather than running it itself. That is
 * worth having for two reasons, and neither is convenience:
 *
 *   - the output is ours as it happens, so a turn can be watched rather than
 *     guessed at;
 *   - `terminal/kill` stops ONE command. Without it the only stop available is
 *     `session/cancel`, which ends the whole turn and everything it had built up.
 *
 * The cost is ownership. Sandboxing, timeouts, output bounds and reaping are the
 * client's problem the moment it advertises the capability -- the agent stops
 * doing any of it. `server.cwd` contains file access for the same reason it
 * contains `fs/*`, and everything else here exists because a process is harder to
 * take back than a file write.
 */

/** True when `child` is inside `root` -- the same containment `fs/*` uses. */
function within(root, child) {
  const rel = relative(root, resolve(root, child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Keeps the last `limit` bytes of a stream, cut at a character boundary.
 *
 * The protocol is specific about both halves: truncation drops from the BEGINNING
 * (a build's last lines are the ones that say what happened), and the retained
 * output must still be a valid string even if that means keeping slightly less
 * than asked for. A naive byte slice splits multi-byte characters and hands the
 * agent a replacement character where a path used to be.
 */
export class Tail {
  #chunks = [];
  #bytes = 0;

  constructor(limit) {
    this.limit = limit;
    this.truncated = false;
  }

  push(buf) {
    this.#chunks.push(buf);
    this.#bytes += buf.length;
    if (this.#bytes <= this.limit) return;
    // Collapse first: dropping whole chunks would overshoot, and a single write
    // larger than the limit has to be cut inside itself.
    const all = Buffer.concat(this.#chunks, this.#bytes);
    const cut = all.subarray(all.length - this.limit);
    this.#chunks = [cut];
    this.#bytes = cut.length;
    this.truncated = true;
  }

  toString() {
    const all = Buffer.concat(this.#chunks, this.#bytes);
    if (!this.truncated) return all.toString("utf8");
    // Skip any UTF-8 continuation bytes (10xxxxxx) left at the front by the cut.
    let i = 0;
    while (i < all.length && (all[i] & 0xc0) === 0x80) i++;
    return all.subarray(i).toString("utf8");
  }
}

/** One running (or finished) command. */
class Terminal {
  constructor(child, limit) {
    this.child = child;
    this.tail = new Tail(limit);
    this.exit = null; // {exitCode, signal} once it has finished
    this.done = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exit = { exitCode: code ?? null, signal: signal ?? null };
        resolve(this.exit);
      });
      child.once("error", () => {
        // A spawn failure still has to settle: an agent waiting on exit would
        // otherwise wait for the life of the session.
        this.exit ??= { exitCode: null, signal: null };
        resolve(this.exit);
      });
    });
    child.stdout?.on("data", (b) => this.tail.push(b));
    // One stream, because that is what a terminal is. Keeping them apart would
    // reorder a command's own interleaving of progress and errors.
    child.stderr?.on("data", (b) => this.tail.push(b));
  }

  /**
   * Ends the command and everything it started.
   *
   * The whole process GROUP, not the child: a shell that spawned a build leaves
   * the build running when only the shell is signalled, and that orphan holds the
   * workspace and the CPU with nobody left to stop it. `detached: true` at spawn
   * is what makes the negative pid legal.
   */
  kill(signal = "SIGKILL") {
    if (this.exit) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Every terminal one agent has open.
 *
 * Scoped per agent rather than globally so that closing an agent reaps exactly
 * its own processes, and so one runaway agent cannot spend another's budget.
 */
export class Terminals {
  #open = new Map(); // terminalId -> Terminal
  #seq = 0;

  /**
   * @param {object} opts
   * @param {string} opts.cwd workspace root; nothing runs outside it
   * @param {number} opts.max how many may run at once
   * @param {number} opts.outputByteLimit default cap when the agent names none
   * @param {number} opts.timeoutMs wall-clock bound on a single command
   */
  constructor({ cwd, max = 8, outputByteLimit = 1_048_576, timeoutMs = 1_800_000, log = () => {} } = {}) {
    this.cwd = cwd;
    this.max = max;
    this.outputByteLimit = outputByteLimit;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  get size() {
    return this.#open.size;
  }

  create({ command, args = [], env = [], cwd = null, outputByteLimit = null }) {
    if (this.#open.size >= this.max) {
      throw new Error(`too many terminals open (${this.max}); release one first`);
    }
    const dir = cwd ? resolve(this.cwd, cwd) : this.cwd;
    if (!within(this.cwd, dir)) throw new Error(`cwd outside workspace: ${cwd}`);

    const child = spawn(command, args, {
      cwd: dir,
      // Its own process group, so `kill` can take the whole tree. Nothing is
      // inherited from this process's stdio: the agent reads output through
      // `terminal/output`, and a child writing onto our stdout would corrupt the
      // ACP stream itself.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...Object.fromEntries(env.map((e) => [e.name, e.value])) },
    });

    const id = `term_${++this.#seq}`;
    const term = new Terminal(child, outputByteLimit ?? this.outputByteLimit);
    this.#open.set(id, term);

    // A command nobody ever kills and nobody ever waits for would outlive the turn,
    // the session and the conversation. The agent decides when to stop waiting;
    // this decides when to stop running.
    if (this.timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (term.exit) return;
        this.log("warn", `terminal ${id} killed after ${this.timeoutMs}ms: ${command}`);
        term.kill();
      }, this.timeoutMs);
      // Never hold the event loop open on behalf of a command.
      timer.unref?.();
      term.done.then(() => clearTimeout(timer));
    }

    return id;
  }

  #get(terminalId) {
    const term = this.#open.get(terminalId);
    if (!term) throw new Error(`unknown terminal ${terminalId}`);
    return term;
  }

  output(terminalId) {
    const term = this.#get(terminalId);
    return {
      output: term.tail.toString(),
      truncated: term.tail.truncated,
      // Absent while it is still running: the field is what says "finished".
      ...(term.exit ? { exitStatus: term.exit } : {}),
    };
  }

  async waitForExit(terminalId) {
    return await this.#get(terminalId).done;
  }

  kill(terminalId) {
    this.#get(terminalId).kill();
  }

  /**
   * Drops a terminal, killing it first if it is still running.
   *
   * Release is the agent saying it no longer cares. A still-running command it
   * has stopped caring about is exactly the orphan this class exists to prevent,
   * so it is killed rather than left.
   */
  release(terminalId) {
    const term = this.#open.get(terminalId);
    if (!term) return;
    term.kill();
    this.#open.delete(terminalId);
  }

  /** Reaps everything. Called when the agent shuts down. */
  releaseAll() {
    for (const id of [...this.#open.keys()]) this.release(id);
  }
}
