/**
 * Turns an agent's own activity into short notes a human can read.
 *
 * An ACP agent reports what it is doing -- `tool_call`, `tool_call_update`, `plan`
 * -- and a chat completion has nowhere to put any of it: the body is an answer, and
 * a trace written into the answer becomes part of the answer. So this module
 * renders those updates as lines that travel in the REASONING channel, alongside
 * the thinking that is already there. A caller that shows reasoning shows progress;
 * one that ignores it is unaffected, and nothing here is ever part of the text.
 *
 * The notes are deliberately terse. They are read while the turn is still running,
 * in a chat window, next to everything else the reader is doing.
 */

/** A tool call that has reached one of these is finished, for better or worse. */
const TERMINAL = new Set(["completed", "failed"]);

/**
 * How many lines a diff adds and removes.
 *
 * Counted rather than rendered: a whole file rewrite is a legitimate edit and a
 * legitimate diff, and pasting one into a progress note buries every other line of
 * the turn. `null` when the payload is not a diff we can measure.
 */
function diffShape(content) {
  if (!content || content.type !== "diff" || typeof content.newText !== "string") return null;
  const before = content.oldText == null ? [] : content.oldText.split("\n");
  const after = content.newText.split("\n");
  // A line-level count, not a real diff: enough to say how big the edit was, and
  // it costs nothing. `oldText: null` is a new file, so every line is an addition.
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  let tail = 0;
  while (
    tail < before.length - common &&
    tail < after.length - common &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { path: content.path ?? "", added: after.length - common - tail, removed: before.length - common - tail };
}

/**
 * What a shell command printed, and how it ended.
 *
 * Two shapes carry the same thing, and which one arrives depends on a capability
 * the CLIENT declares -- so both are read rather than one being chosen:
 *
 *   - `_meta.terminal_output.data` plus `_meta.terminal_exit.exit_code`, sent by
 *     `claude-agent-acp` and `codex-acp` when the client advertises
 *     `clientCapabilities._meta.terminal_output`. This one carries the exit code.
 *   - a ```console fenced block in the ordinary `content`, which is what the same
 *     agents fall back to otherwise. No exit code, but the output is all there.
 *
 * `null` when this was not a command, or printed nothing.
 */
export function terminalResult(u) {
  const meta = u?._meta ?? {};
  let output = typeof meta.terminal_output?.data === "string" ? meta.terminal_output.data : null;
  // The exit code arrives in an update of its OWN, carrying no output at all --
  // so it is read independently. Requiring both together is what made every
  // command look successful.
  const exitCode = typeof meta.terminal_exit?.exit_code === "number" ? meta.terminal_exit.exit_code : null;

  if (output === null) {
    for (const entry of u?.content ?? []) {
      const text = entry?.type === "content" ? entry.content?.text : null;
      if (typeof text !== "string") continue;
      const fenced = /^```console\n([\s\S]*?)\n?```$/.exec(text.trim());
      if (fenced) {
        output = fenced[1];
        break;
      }
    }
  }
  return output === null && exitCode === null ? null : { output, exitCode };
}

/**
 * The last `n` non-empty lines, each clipped to one line's worth.
 *
 * The END, because that is where a command says what happened -- a build prints
 * a thousand lines of progress and one line of verdict. Bounded hard: this lands
 * in a chat post next to everything else the reader is doing, and an unbounded
 * `npm test` would bury the entire turn.
 */
export function tail(output, n) {
  if (!(n > 0)) return [];
  const lines = String(output).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  return lines.slice(-n).map((l) => oneLine(l, 160));
}

/** Collapses whitespace and clips, so one note is always one line. */
const oneLine = (text, max = 120) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Per-turn progress state.
 *
 * Stateful because the interesting events are transitions: a tool call is worth a
 * note when it STARTS and when it FAILS, and a plan when it changes. ACP repeats
 * the rest -- `tool_call_update` arrives for every status change and often carries
 * the whole call again -- so without memory the same work would be narrated several
 * times over.
 *
 * One instance per turn. Reusing one across turns would suppress the second turn's
 * notes for anything the first had already mentioned.
 */
export class Progress {
  // id -> what we know about that call so far. A call is NOT one update: measured
  // on the wire, a single Bash invocation arrives as six, and the pieces a reader
  // needs are spread across them -- the command in the second, the output in the
  // fifth, the exit code in the sixth, and none of those three carries the other
  // two. Accumulating is the only way to say anything useful about it.
  #calls = new Map();
  #done = new Set();
  #plan = null;

  /** @param {number} outputLines how many trailing lines of command output to show */
  constructor(outputLines = 0) {
    this.outputLines = outputLines;
  }

  /**
   * A note for one `session/update`, or null when there is nothing new to say.
   *
   * @param {object} update the raw ACP session update
   * @returns {string|null}
   */
  note(update) {
    switch (update?.sessionUpdate) {
      case "tool_call":
      case "tool_call_update":
        return this.#tool(update);
      case "plan":
      case "plan_update":
        return this.#planNote(update);
      default:
        return null;
    }
  }

  #tool(u) {
    const id = u.toolCallId ?? "";
    if (!id || this.#done.has(id)) return null;

    const call = this.#calls.get(id) ?? {
      label: null,
      command: null,
      announced: false,
      output: null,
      exitCode: null,
    };
    this.#calls.set(id, call);

    // WHY first, then WHAT. A coding agent writes a one-line reason for every
    // command it runs -- Claude Code's Bash tool takes a `description` next to
    // the `command` -- and that sentence is the difference between a trace you
    // read and a wall of shell you decode.
    //
    // It has to be dug out of `rawInput`, because the adapter drops it: for a
    // Bash call `claude-agent-acp` sets `title` to the COMMAND, and passes the
    // description through in `content` only when the client did NOT ask for
    // terminal output -- which any client that wants to show output does. So the
    // more capable the client, the less it is told. `rawInput` carries the whole
    // tool input regardless, so this reads it there.
    //
    // The name also improves as the agent learns it: a Bash call opens as the
    // literal "Terminal" with an EMPTY rawInput -- the command is still being
    // streamed -- and only the next update carries it. Taking the first title
    // would name every command "Terminal"; taking the last one names it
    // correctly. `kind` last: it is a category, not a name, and only worth
    // showing when the agent never says anything better.
    const named = u.rawInput?.description || u.title || u.rawInput?.command || u.kind || null;
    if (named) call.label = oneLine(named);
    if (typeof u.rawInput?.command === "string") call.command = oneLine(u.rawInput.command);
    const shell = terminalResult(u);
    if (shell?.output) call.output = shell.output;
    if (shell?.exitCode != null) call.exitCode = shell.exitCode;

    const lines = [];
    // Announce once the call is worth announcing: a title AND some idea of what it
    // is doing. `rawInput: {}` means the agent does not know yet either, and
    // saying "› Terminal" then is worse than a half-second of silence. A terminal
    // status forces the announcement regardless -- every call ends, so nothing can
    // stay unannounced forever.
    // Announce once the call is worth announcing. `rawInput: {}` means the agent
    // does not know what it is doing yet either, and saying "› Terminal" then is
    // worse than a half-second of silence.
    //
    // A command waits for its `description` as well, and that is a deliberate
    // extra beat. The tool input is streamed as it is generated, so `command`
    // lands one update before `description` -- announcing on the first of the two
    // would mean the reason NEVER shows, since a call is announced once. The two
    // updates are milliseconds apart.
    //
    // A terminal status forces the announcement regardless, so nothing can stay
    // unannounced forever: an execute call from an agent that sends no
    // description at all is announced when it finishes, late but never lost.
    const known = Object.keys(u.rawInput ?? {}).length > 0;
    const described = u.kind !== "execute" || call.command === null || Boolean(u.rawInput?.description);
    if (!call.announced && call.label && ((known && described) || TERMINAL.has(u.status))) {
      call.announced = true;
      lines.push(`› ${call.label}`);
      // The command on its own line, and only when the label is something else --
      // i.e. when a description was found. Both matter and neither replaces the
      // other: the description says why, and the command is what you check when
      // the answer looks wrong or the exit code is not zero. `permission denied
      // ... /var/run/docker.sock` was read straight off one of these.
      if (call.command && call.command !== call.label) lines.push(`$ ${call.command}`);
    }

    if (TERMINAL.has(u.status)) {
      this.#done.add(id);
      this.#calls.delete(id);
      // What a command actually printed, which for an `execute` call is usually
      // the only part worth reading. It arrived in an EARLIER update than this
      // one, which is why it is read from the accumulated call and not from `u`.
      if (call.output) lines.push(...tail(call.output, this.outputLines).map((l) => `⎿ ${l}`));
      // Success is implied by the next line; only a failure needs saying. An exit
      // code says more than "failed" when the agent gives us one.
      if (u.status === "failed" || call.exitCode) {
        lines.push(`✗ ${call.label ?? "tool"}${call.exitCode ? ` (exit ${call.exitCode})` : ""}`);
      }
      for (const shape of (u.content ?? []).map(diffShape)) {
        if (shape) lines.push(`± ${shape.path} +${shape.added}/-${shape.removed}`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : null;
  }

  #planNote(u) {
    const entries = u.entries ?? u.plan?.entries ?? [];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const done = entries.filter((e) => e?.status === "completed").length;
    const current = entries.find((e) => e?.status === "in_progress") ?? entries.find((e) => e?.status === "pending");
    const line = `▸ plan ${done}/${entries.length}${current?.content ? ` — ${oneLine(current.content, 80)}` : ""}`;
    // A plan update fires on every entry transition, and most of those leave this
    // summary identical. Saying the same thing twice is worse than saying nothing.
    if (line === this.#plan) return null;
    this.#plan = line;
    return line;
  }
}
