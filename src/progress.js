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
  #started = new Set();
  #finished = new Set();
  #plan = null;

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
    const label = oneLine(u.title || u.kind || "tool");
    const lines = [];

    // The start. `tool_call` and `tool_call_update` are not reliably distinct --
    // some agents open with an update, and the fixture's initial `tool_call`
    // already carries a terminal status -- so the first sighting is what counts.
    if (id && !this.#started.has(id)) {
      this.#started.add(id);
      lines.push(`› ${label}`);
    }

    if (TERMINAL.has(u.status) && id && !this.#finished.has(id)) {
      this.#finished.add(id);
      // Success is implied by the next line; only a failure needs saying.
      if (u.status === "failed") lines.push(`✗ ${label}`);
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
