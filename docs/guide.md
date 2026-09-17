# The guide

What acp2api does beyond the quick start, one section per feature, each with a
request that exercises it. The compatibility claims below are bounded to the
implemented and tested surface; individual ACP agents still vary by version,
configuration and login.

A coding agent is not a chat model, and the gap between the two is where every
feature comes from: a turn runs for minutes, holds state you paid for, narrates
itself, runs commands. An OpenAI client knows none of that, and everything here
exists to make one behave sensibly anyway.

## Continuity: a stateless caller becomes a conversation

The OpenAI API asks every client to resend its whole history each time. Taken
literally that restarts the agent on every message — it re-reads a growing
transcript and loses the working state it had built (its plan, its open files, its
own subagents), which for an agent is most of what it knows.

So an incoming history is matched against live sessions by longest prefix, and only
the unheard tail is sent:

```
claude-haiku: new session for 1 message(s)
claude-haiku: continuing session, 1 new of 3 message(s)
```

No client support is required — the caller stays stateless and the continuity
happens here. A diverging history (edited, branched, trimmed) or a changed system
prompt still gets a fresh session, because neither is a continuation. Disable with
`server.continuity: false`.

## Naming a conversation, when inferring it cannot work

Prefix matching has a hard limit worth stating plainly: it only helps a caller that
resends a growing transcript. A caller that keeps the transcript on its own side —
an agent framework, a chat gateway — hands over **one rolled-up turn per request**.
No two requests share a prefix, nothing ever matches, and every message gets a cold
agent. No amount of tuning changes that.

Such a caller can name the conversation instead:

```
POST /v1/chat/completions
x-conversation-id: mattermost:channel:c8f3…:thread:9ab1…
```

Any stable string will do — a thread id, a chat id, a session id. Same key, same
ACP session:

```
claude-haiku: new session for 1 message(s) [mattermost:channel:c8f3…]
claude-haiku: continuing session keyed [mattermost:channel:c8f3…], 1 new of 1 message(s)
```

A key is stronger evidence of identity than a prefix, so it also survives what
prefix matching deliberately refuses: an edited system prompt, a trimmed history, a
compacted transcript. That is the point — a real caller rewrites its own preamble
constantly (injected memory, a user profile, the date the thread started), and
forking on each such change would mean never continuing anything.

The header name is `server.conversationHeader`; set it to `""` to ignore it.
Requests without it fall back to prefix matching.

If a named conversation is already serving a turn, the default `server.busy:
fork` refuses the second request with **409 `conversation_busy`**. The key asserts
that both requests belong to one conversation, so opening another session would
silently rebind that key and orphan the running turn. Headerless callers do not
assert that identity: when their matching conversation is busy, they continue to
get a session of their own.

## Saying something while the turn is still running

A coding-agent turn runs for minutes behind a single completion. Without a way in,
correcting work that went wrong in its first thirty seconds means waiting for the
whole thing to finish.

Turn it on with `server.busy: queue`, then send the correction to the **same**
conversation, marked as an injection:

```
POST /v1/chat/completions
x-conversation-id: mattermost:thread:9ab1…
x-acp2api-inject: 1

{"model":"claude-opus","messages":[{"role":"user","content":"also run the linter"}]}
```

It answers **200 with an empty message**, immediately. That is the honest shape of
"delivered, nothing to say": the answer belongs to the turn you joined and reaches
whoever is waiting on *that* request. Measured against codex, injected twelve
seconds into a turn whose first command was a 45-second sleep — the original work
finished, the injected command ran too, and both came back in the original
request's answer.

A miss costs nothing, which is what makes this usable from a caller that has to
guess which model a thread is on:

| | |
| --- | --- |
| **409** `no_running_turn` | no turn to join, or the agent cannot be steered. Try the next model. |
| **200**, empty content | it landed |

Without `x-acp2api-inject` a miss would fall through to the ordinary path and start
a whole turn of a real subscription, streaming to a caller that is not listening.

**Requirements and limits.** The agent must advertise `_meta.steering.supported` —
`claude-agent-acp` ≥ 0.66.0 and `codex-acp` ≥ 1.1.14 both do. ACP itself defines no
mid-turn input; `_session/steering` is the extension both implement, and an agent
without it is refused rather than sent something that might wedge it. Only a
**named** conversation can be joined: prefix matching cannot identify a
conversation whose transcript is still being written.

**Steering redirects; it does not append.** The message pre-empts the current
generation, and what happens to the unfinished plan is the model's decision. "Do
exactly X" is read as a replacement, and the rest may be abandoned. Say "as well as
what you are already doing" when that is what you mean.

## Going quiet does not lose the work

A conversation nobody has continued past `sessionTtlMs` is **parked**, not ended:
it closes that ACP session and keeps the session id. The shared lazy agent child may
remain alive for other conversations. The next message attempts `session/resume`
with the original cwd and complete MCP set.

```
fake: session conv_msp… parked: sess_01H…
fake: resumed sess_01H… [mattermost:channel:c8f3…]
```

So the bounds mean what they should: `maxSessions` caps resident sessions,
`sessionTtlMs` decides when to give one back, and `forgetTtlMs` — a day by default
— is what finally forgets a conversation. Resume is fail-closed: if the agent no
longer has the id, continuation fails rather than silently opening an empty session
that lost the conversation. Start a new conversation explicitly when losing state
is acceptable.

Two other things end or retire a session. `maxContextFill` retires one that has
used up its context window, because the alternative is the agent's own compaction
and then a wall no retry gets past. A timed-out keyed Chat turn may keep its session
when cancellation drains safely, so a correction can continue the work; an agent
failure or a turn that cannot be drained retires it rather than offering state the
bridge can no longer account for. Responses uses the stricter id invalidation
rules described below.

## Starting warm instead of cold

A cold session re-orients before it can do anything: it reads the project's
instructions, lists the tree, greps for its bearings. That is real tokens, and every
new conversation pays for it again.

```yaml
    warmup:
      prompt: Read AGENTS.md and get your bearings. Do not change anything.
      ttlMs: 3600000
```

acp2api runs that once, then `session/fork`s the result for every conversation, so
each starts already oriented and still gets a session of its own. The warm-up is a
real turn against a real subscription, run once per `ttlMs` — worth having when
conversations start often enough to amortise it, which is why there is no default.

Everything about it fails soft. No `sessionCapabilities.fork`, a warm-up that
throws, a fork that is refused: the session simply opens cold, which is slower and
never wrong.

## Watching a turn happen

`server.progress: reasoning` narrates what the agent is doing into
`reasoning_content`, next to the thinking already there:

```
▸ plan 1/3 — patch the compose file
› Edit compose.yaml
± compose.yaml +2/-1
› pytest -q
⎿ 1 failed, 42 passed in 3.10s
✗ pytest -q (exit 1)
```

`progressOutputLines` bounds how much of a command's output is shown — the last
few lines, because that is where a command says what happened. Both shapes agents
send it in are read, so no capability has to be negotiated for it to appear.

Never into the answer: a trace written into the text becomes part of the text, and
comes back as the assistant's own words on the next turn. Off by default, so a
caller already rendering reasoning as prose does not suddenly start showing tool
traffic.

ACP also does not label prose emitted before a tool call as commentary. By default
`server.commentary: answer` preserves it in answer text. With `commentary: trace`,
only prose that a following tool call proves was intermediate is moved to the
reasoning channel; a turn that never calls a tool is unchanged. This mode buffers
each prose run until the next tool call or the end of the turn—text already sent as
an answer delta cannot later be reclassified.

## Running the agent's commands yourself

`server.terminal: true` advertises ACP's `terminal` capability, and an agent that
sees it routes its shell work through the bridge instead of running it itself. Two
things follow: the output is yours as it happens, and `terminal/kill` stops **one**
command — where the only other stop is `session/cancel`, which ends the whole turn
and everything it had built up.

This is a transfer of responsibility, not an extra feature. Containment, timeouts,
output bounds and process reaping stop being the agent's problem and become the
bridge's:

- commands run inside `server.cwd`, the same boundary `fs/*` uses, and a `cwd`
  outside it is refused with a reason the agent can read;
- each command is its own process group, so a kill takes the build a shell
  started and not just the shell;
- output keeps the last `terminalOutputBytes`, cut at a character boundary;
- `terminalTimeoutMs` bounds a command nobody kills and nobody waits for;
- `maxTerminals` bounds how many run at once, and everything is reaped when the
  agent shuts down — before the CLI is killed, or its children outlive it.

Off by default, because an agent that was sandboxing its own execution stops doing
so the moment this is on.

## Your tools, in the agent's hands

Send `tools` the way you always would, and they reach the agent:

```jsonc
POST /v1/chat/completions
x-conversation-id: thread-9ab1        // recommended stable conversation identity

{ "model": "claude-opus",
  "messages": [{"role": "user", "content": "What are the 2026 company holidays?"}],
  "tools": [{"type": "function", "function": {"name": "company_holiday", "parameters": {…}}}] }
```

You get back the supported OpenAI-shaped tool-call subset:

```jsonc
{"choices": [{"finish_reason": "tool_calls",
  "message": {"role": "assistant", "content": null,
    "tool_calls": [{"id": "call_83766e91", "type": "function",
      "function": {"name": "company_holiday", "arguments": "{\"year\":\"2026\"}"}}]}}]}
```

Run it, send the result back as a `tool` message in the same conversation, and the
turn finishes. The live `tool_call_id` identifies the suspended Chat turn and takes
precedence over a conflicting conversation header. Results spanning two suspended
turns are refused as ambiguous, and a concurrent request for the same named
conversation receives 409 rather than interleaving with the owner.

**`session/prompt` has no `tools` field**, and will not get one — an ACP agent runs
its own loop, and the protocol's answer to "where do tools come from" is
`mcpServers`. So acp2api *becomes* a tool server: a small MCP server on its own
port whose tool list is whatever your request declared.

What that buys you is the part worth knowing: **the turn does not end at the
call.** It sits inside the MCP request while your completion returns, so when the
result arrives the agent picks up exactly where it was — mid-plan, with everything
it had read still in hand — instead of re-planning from a summary. A parked call
has a deadline (`toolTimeoutMs`); a caller that never answers cannot leave an agent
waiting on a paid subscription forever.

`/v1/responses` does the same thing in its own spelling: the call arrives as a
`function_call` output item with a `call_id`, and you answer it with a
`function_call_output` item on the next request. Streaming works on both. Responses
emits item-added, argument delta/done and item-done events even when ACP supplied
the arguments in one piece.

If an agent has these tools but finishes by printing call-shaped text such as
`submit_plan({"x":1})`, acp2api leaves that answer exactly as written and adds
`x_acp2api.suspected_text_tool_call: {agent, tool}`. It also logs one warning. The
annotation is evidence of an imitation, not permission to fabricate a real call;
the caller still received ordinary answer text. In the field, Codex at low
reasoning imitated `submit_plan`, while high reasoning made the actual tool call.
Raise that agent's configured `reasoning` when this annotation appears.

This path has automated end-to-end coverage with the repository's ACP fixture;
dated live-agent observations are recorded separately in [agents.md](agents.md).
Set `server.tools: off` to drop caller tools instead.

## The agent's own tools come from MCP

Tools that belong to the *agent* rather than to the caller are declared when its
session opens, and it uses them without asking anyone:

```yaml
agents:
  - name: claude-opus
    type: claude
    mcpServers:
      - name: docs
        url: https://mcp.example.com/mcp
        headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
      - name: local
        command: /usr/local/bin/my-mcp
        args: [--stdio]
        env: { API_KEY: "${KEY}" }
```

Mappings for `headers`/`env` are converted to the `[{name, value}]` arrays ACP
actually wants. Claude speaks `http` and `sse`, Codex `http`.

## What OpenAI parameters do

Browser access is deliberately off. acp2api has no authentication of its own, so
default-open CORS would turn a local coding agent into a capability any web page
could call. Set `server.cors` to one trusted origin, such as
`https://app.example`, or to `true` only when the wildcard `*` is intentional.
Enabled CORS covers preflight requests and every API response.

`session/prompt` carries exactly `{sessionId, prompt, _meta}` — no sampling knobs,
no tools, no response format. An ACP agent is an *agent*, not a raw model endpoint:
it owns its inference settings. There is no lower layer that exposes OpenAI
sampling controls; `claude-agent-acp` has process-level model and thinking-budget
environment settings, but no temperature to set anywhere.

So parameters are split by **what breaks if we proceed**, not by what is supported.

| | behaviour |
| --- | --- |
| `model`, `messages`, `stream`, `reasoning_effort` | native when the agent advertises the matching option |
| `max_completion_tokens` / `max_tokens`, `stop` | **emulated for real** — the output is watched and the turn cut short (`max_completion_tokens` wins; token counts are approximate because there is no tokenizer here) |
| `stream_options.include_usage` | native |
| `temperature`, `top_p`, `seed`, penalties, `logprobs`, unknown fields | **accepted and ignored.** Every client library sends `temperature` unasked; failing on it would reject nearly every real request over a difference the caller cannot perceive |
| `tools` | **served by default.** The bridge exposes caller tools through a per-conversation MCP server and can return `tool_calls`; set `server.tools: off` to drop them and report `tools` in `x_acp2api.ignored`. See [Your tools in the agent's hands](#your-tools-in-the-agents-hands) |
| `tool_choice: "auto"` | supported; the ACP agent chooses whether to call a served tool |
| `tool_choice: "none"` | supported; caller tools are withheld for that turn |
| `tool_choice: "required"` / named, `strict: true` | **400.** ACP cannot guarantee selection or constrained arguments |
| `functions`, `function_call` | **accepted and ignored.** Use `tools` for caller-served functions |
| `response_format`, `n > 1`, `audio` | **400.** Nothing gives the caller its guarantee back |

Ignored parameters are never silent: they are logged once per (model, parameter)
and echoed back on the response as `x_acp2api.ignored`, which no client trips over
because everything reads `choices[0]`. Set `server.unsupportedParams` to `ignore`
to drop the reporting or `error` to refuse those too.

## Response facts in `x_acp2api`

`x_acp2api` is the bridge's append-only annotation channel. Its fields and documented
placements are never removed or renamed. They appear only when the bridge has the
corresponding fact; missing telemetry is absent, never invented as zero:

```jsonc
"x_acp2api": {
  "context": {"used": 8123, "size": 200000, "ratio": 0.0406},
  "cost": {"amount": 0.03125, "currency": "USD"},
  "session": {"replayed": true, "reason": "context_fill"}
}
```

`context.used` and `context.size` are the raw values the agent reported. `ratio` is
`used / size`, rounded to four decimal places for a stable display value; use the
raw pair when more precision matters. `cost` is the agent's own account of this
turn, settled from its session-cumulative report rather than computed by the
bridge.

`session` appears on the first Chat response after a retired conversation had to be
replayed into a fresh ACP session. The reason is one of:

| reason | meaning |
| --- | --- |
| `context_fill` | the previous session reached `maxContextFill` |
| `forgotten` | the conversation outlived `forgetTtlMs` — this is the field requester's `ttl`; an ordinary TTL park is not retirement |
| `revive_failed` | the agent could not resume a parked session |
| `dead_session` | a cancelled turn failed to drain and killed the session |
| `abandoned_tool_turn` | the caller sent new input instead of answering a suspended tool call |
| `late_results` | tool results arrived after their suspended turn had already settled |

The annotation is consumed once. A genuinely new Chat conversation has no
`session` field. Responses continuations already have a proxy-proof address in
`previous_response_id`; after retirement that id returns 404 instead of silently
replaying, so Responses never receives this tombstone annotation.

Non-streaming Chat and direct Chat SSE consumers read the top-level `x_acp2api`.
LiteLLM 1.96.0 strips unknown top-level fields while rebuilding choice-bearing SSE
chunks, but preserves its first-class provider extension channel byte-for-byte. A
Chat terminal chunk therefore mirrors the complete extension in both places:

```jsonc
{
  "choices": [{
    "delta": {
      "provider_specific_fields": {"x_acp2api": { /* same complete value */ }}
    }
  }],
  "x_acp2api": { /* same complete value */ }
}
```

The two placements are one value built once, not independently selected fields:
`context`, `cost`, `session`, `ignored`, `suspected_text_tool_call`, and future
additions appear in both automatically. When there is no annotation, both are
absent. The top-level placement remains for direct SSE consumers; proxied SSE
consumers read `choices[0].delta.provider_specific_fields.x_acp2api`.

Responses streams are unchanged: their extension lives in the response object
carried by the terminal `response.completed` event. No API introduces an extra SSE
event for annotations.

The ACP-native way to vary what a request cannot carry is **another agent entry**:
names are model ids, so "codex at low effort" is simply another model id.

Attachments work: an OpenAI `file` part with `file_data` becomes an ACP `resource`
block (text inline, anything else as a blob). `file_id` is refused — it names an
OpenAI-hosted file that does not exist here.

`server.agentRpcTimeoutMs` bounds ACP control calls (`initialize`, session setup,
configuration, fork and resume). It does not cap a normal agent turn—that remains
under `requestTimeoutMs`—but it does bound how long a cancelled turn may ignore
`session/cancel` before its session is retired.

`model` and `reasoning` are matched by
[category](https://agentclientprotocol.com/protocol/session-setup), never by option
id, because the ids differ per agent — Claude calls its reasoning selector `effort`,
Codex calls it `reasoning_effort`. A `model` the agent does not offer is a **400**,
never a silent fallback: you named that agent to get that model.

The configured model and raw options are applied before acp2api captures the
session's reasoning baseline. A request-level `reasoning_effort` (Chat) or
`reasoning.effort` (Responses) is temporary: the next request without an override
restores that baseline. Parking and `session/resume` preserve the same baseline,
including an explicitly configured `reasoning` value; an unavailable requested
effort is a 400 instead of a silent fallback.

For a `type: claude` agent, acp2api passes its configured `model` as
`ANTHROPIC_MODEL` when it starts the adapter. An explicit `ANTHROPIC_MODEL` under
the agent's `env:` mapping wins over that derived value. The live option still
decides the truth: if `session/new` reports a different but offered
`currentValue`, acp2api sets the model through ACP and warns that the resulting
`/model` entry will be visible to the next turn. It never keeps a clean transcript
by silently running the wrong model.

Agent model lists move. On 2026-08-27, an adapter replaced `opus` with `opus[1m]`;
the correct 400 prevented a silent fallback, but did not reveal the new spelling.
Probe the configured agent directly:

```sh
acp2api --config acp2api.yaml --probe claude-opus
```

The output includes the live value before acp2api applies its config:

```jsonc
{"configOptions": [{"id": "model", "category": "model", "type": "select",
  "currentValue": "default", "values": [{"value": "opus[1m]", "name": "Opus (1M context)"}, …]}]}
```

The command prints live config options (id, semantic category, type, current value,
and named values) plus steering, session, and MCP capability highlights. It reuses the same
ACP connection and session setup as the server, then closes cleanly. It never sends
a prompt, so diagnosing a moved model list does not spend a subscription turn.
For Claude, a model `currentValue` equal to the configured model confirms that the
environment bypass will avoid the transcript-visible model-setting RPC.

## /v1/responses is the better fit

The Responses API is stateful and so is ACP, which makes the mapping direct rather
than approximate:

| OpenAI | ACP |
| --- | --- |
| `previous_response_id` | the latest retained session tip — the agent's own memory of the turn |
| `instructions` | an explicitly limited text-preamble emulation |
| `reasoning: {effort}` | the `thought_level` config option, **per request** |
| `max_output_tokens` | the same output-watching cut as `max_tokens` |
| `store: false` | return the result without retaining it; when continuing a chain, close its continuation state |

```sh
curl localhost:10021/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus","input":"My favourite number is 41. Reply: noted"}'
# {"id":"resp_...","output_text":"noted", ...}

curl localhost:10021/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus","input":"What was my number?","previous_response_id":"resp_..."}'
# "41"
```

The second request sends **only the new input** and must name the latest successful
stored response. A known older id gets `409 stale_previous_response`; an unknown or
unrecoverable id gets 404. A second concurrent claimant—including a duplicate
`function_call_output`—gets `409 conversation_busy` without changing the first
request's state. Chat completions has to resend the
whole history each time and the agent reads it as one flattened transcript; here the
agent already holds it. `reasoning.effort` can likewise be raised for one hard
question mid-conversation; omitting it next time restores the configured/session
baseline. Chat uses `reasoning_effort` and follows the same reset rule.

`instructions` are not a native ACP system-role channel: acp2api places them in the
initial text. An explicitly identical value may continue, but adding, changing or
removing it after the first response is refused because old text cannot be erased
from the agent's history. Start a new chain to change instructions.

Request-shape and option validation happens before an ACP prompt begins. A
correctable 400 at that stage releases the claim and leaves the latest id usable.
Once a prompt or matching tool result has advanced the ACP turn, a failure,
timeout or disconnect invalidates the old id: retrying it returns 404 because its
stored snapshot no longer matches live history.

Responses tool continuations require stored state: `store: false` with served
tools is refused with 400 `store_required`. A `function_call_output` must name a
pending call from that latest response, may not be mixed with new message input,
and does not permit adding tools to a chain that was opened without them. Resolve
the call first, then send the next message. A successful `store: false`
continuation returns its unstored result, leaves older response bodies readable by
GET, and closes the chain so none of those ids can continue it.

Retained conversations hold live ACP sessions inside the agent process, so resident
sessions are bounded by `server.maxSessions` (parked by last *use*, so an actively
continued conversation outlives a newer idle one) and `server.sessionTtlMs`. Both
close the resident ACP session while retaining its id for `session/resume`.
`maxConversations`, `maxResponses`, and `maxResponseBytes` bound retained Responses
metadata, immutable objects and serialized bytes. Inactive snapshots are evicted
before active/pending chains; if safe eviction cannot make room, admission fails
instead of interrupting an active turn. `server.forgetTtlMs` ends the conversation
outright. Deleting its last stored response, shutting down, and a first turn that
fails before answering also close and discard it.

There is no authentication: acp2api is a local bridge, and authorization is the
job of the router in front of it. It binds loopback by default and warns at startup
if `server.host` makes it reachable elsewhere.

Agent thinking and progress can be surfaced separately from answer text. Treat
these as compatibility extensions and operational trace, not as a guarantee of an
OpenAI reasoning summary or access to raw hidden thoughts. See the exact surface in
[compatibility.md](compatibility.md).
