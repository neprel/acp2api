# acp2api

[![ci](https://github.com/neprel/acp2api/actions/workflows/ci.yml/badge.svg)](https://github.com/neprel/acp2api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/acp2api)](https://www.npmjs.com/package/acp2api)
[![node](https://img.shields.io/node/v/acp2api)](https://www.npmjs.com/package/acp2api)
[![license](https://img.shields.io/npm/l/acp2api)](LICENSE)
[![built with HINT](https://img.shields.io/badge/built_with-HINT-5b4ee6)](https://openhint.dev/)

**Use Claude Code, Codex or any [ACP](https://agentclientprotocol.com) agent from
anything that speaks the OpenAI API.**

Each agent you configure becomes a **model id**. That is the whole interface.

```
   OpenAI client                acp2api                  ACP agent
  (Hermes, LangChain,   ──▶  /v1/chat/completions  ──▶  claude-agent-acp
   OpenWebUI, a router,       OpenAI  ⇄  ACP            codex-acp
   your own script)                                     opencode acp, cline --acp, …
```

It spawns the CLI you are already logged into and spends **that subscription** —
no API key is read, replayed or forwarded.

## Sixty seconds

```sh
npm install -g acp2api
```

```yaml
# acp2api.yaml
server:
  cwd: ./work                # the agents' workspace, and their fs boundary
agents:
  - name: claude-opus        # <- the model id clients ask for
    type: claude
    model: opus
  - name: codex
    type: codex
```

```sh
acp2api --config acp2api.yaml
```

```sh
curl localhost:10021/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"what is in this repo?"}]}'
```

That is a working install. Everything below is what you get for free once it runs,
and what to turn on when you want more.

There is **no authentication** here: acp2api listens on loopback and authorization
belongs to whatever router sits in front. Binding it elsewhere is a `host:` away
and yours to decide.

## What it gives you

A coding agent is not a chat model, and the gap between the two is where every
feature below comes from. A turn runs for minutes, not seconds. It holds state you
paid for — files it read, a plan it built. It narrates itself. It runs commands. An
OpenAI client knows none of that, and everything here exists to make one behave
sensibly anyway. All of it was built against a fleet running in production.

| | what it solves |
| --- | --- |
| [**Conversations, not cold starts**](#continuity-a-stateless-caller-becomes-a-conversation) | The OpenAI API asks clients to be stateless. Replaying a transcript into a coding agent every message throws away everything it had learned. |
| [**Naming a conversation**](#naming-a-conversation-when-inferring-it-cannot-work) | A gateway that keeps the transcript on its side has no growing prefix to match. One header fixes it. |
| [**Steering a running turn**](#saying-something-while-the-turn-is-still-running) | Correcting work that went wrong in its first thirty seconds, without waiting out the other nineteen minutes. |
| [**Parking, not forgetting**](#going-quiet-does-not-lose-the-work) | A thread nobody has touched for an hour gives back its process and keeps its memory. |
| [**Warm starts**](#starting-warm-instead-of-cold) | Every new conversation begins already oriented, for one warm-up instead of one per thread. |
| [**Watching the work**](#watching-a-turn-happen) | Tool calls, diffs and plans on the reasoning channel, so a long turn stops looking like a hang. |
| [**Running the commands yourself**](#running-the-agents-commands-yourself) | Take execution out of the agent and into your process, with your bounds. |
| [**Failover that works**](#status-codes-and-why-they-matter) | An exhausted subscription answers 429, so a router can move to the next model instead of counting a broken agent as an outage. |
| [**Your tools, in the agent's hands**](#your-tools-in-the-agents-hands) | Send OpenAI `tools` and get `tool_calls` back — served to the agent as an MCP server, with the turn held open until your result arrives. |
| [**The agent's own tools**](#the-agents-own-tools-come-from-mcp) | Declared per agent, used without asking: it acts rather than asks. |
| [**Model and effort from config**](#what-openai-parameters-do) | `session/set_config_option` reaches the selectors the CLI exposes, by meaning rather than by vendor id. |

Each has its own section below, with the request that exercises it.

## Why through ACP, and not the vendor's API

Because the subscription is the point. The other way to build this is to borrow a
vendor's OAuth token and call its private HTTP API; that is nicer to code against
and is not yours to do. Here the CLI is spawned and uses the login it already has
(`~/.claude`, `~/.codex`) — nothing is read, replayed or forwarded.

The cost is that everything must fit through ACP's stdio JSON-RPC, which turns out
to be enough: `session/set_config_option` reaches the model selector and the
reasoning level, so an agent is fully specified from config.

The [Claude](https://github.com/agentclientprotocol/claude-agent-acp) and
[Codex](https://github.com/agentclientprotocol/codex-acp) adapters ship with the
package; `--omit=optional` skips them if you only run `general` agents.

## Configure

One YAML file, `${VAR}` and `${VAR:-default}` expanded from the environment. Every
option is documented in [`acp2api.example.yaml`](acp2api.example.yaml) — start from
that. The quickstart above is a valid config; the rest is opt-in.

| key | meaning |
| --- | --- |
| `type` | `claude` and `codex` bundle an adapter; `general` needs `command` |
| `model` | set on the config option whose **category** is `model` |
| `reasoning` | set on the config option whose **category** is `thought_level` |
| `options` | `{configId: value}` for anything else the agent exposes |
| `mcpServers` | tools for this agent — see below |
| `env`, `cwd`, `args` | per-agent spawn overrides |

### Your tools, in the agent's hands

Send `tools` the way you always would, and they reach the agent:

```jsonc
POST /v1/chat/completions
x-conversation-id: thread-9ab1        // required: the turn outlives this request

{ "model": "claude-opus",
  "messages": [{"role": "user", "content": "What are the 2026 company holidays?"}],
  "tools": [{"type": "function", "function": {"name": "company_holiday", "parameters": {…}}}] }
```

You get back exactly what OpenAI would give you:

```jsonc
{"choices": [{"finish_reason": "tool_calls",
  "message": {"role": "assistant", "content": null,
    "tool_calls": [{"id": "call_83766e91", "type": "function",
      "function": {"name": "company_holiday", "arguments": "{\"year\":\"2026\"}"}}]}}]}
```

Run it, send the result back as a `tool` message in the same conversation, and the
turn finishes.

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
`function_call_output` item on the next request. Streaming works on both, with one
honest limit — the call is delivered whole in the terminal event rather than as a
delta sequence, because the turn produced it whole.

Verified against a real Claude Code end to end: the agent listed the tool, called
it, and finished the turn quoting a value that existed nowhere but the result sent
back to it. Set `server.tools: off` to drop them instead, which is what every
version before 1.8.0 did.

### The agent's own tools come from MCP

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

`session/prompt` carries exactly `{sessionId, prompt, _meta}` — no sampling knobs,
no tools, no response format. An ACP agent is an *agent*, not a raw model endpoint:
it owns its inference settings. There is no lower layer to reach either;
`claude-agent-acp` reads only `ANTHROPIC_MODEL`, `MAX_THINKING_TOKENS` and
`CLAUDE_CONFIG_DIR` — there is no temperature to set, anywhere.

So parameters are split by **what breaks if we proceed**, not by what is supported.

| | behaviour |
| --- | --- |
| `model`, `messages`, `stream` | native |
| `max_tokens`, `stop` | **emulated for real** — the output is watched and the turn cut short (token counts are approximate; there is no tokenizer here) |
| `stream_options.include_usage` | native |
| `temperature`, `top_p`, `seed`, penalties, `logprobs`, unknown fields | **accepted and ignored.** Every client library sends `temperature` unasked; failing on it would reject nearly every real request over a difference the caller cannot perceive |
| `tools`, `tool_choice`, `functions` | **accepted and ignored.** An ACP agent runs its own tool loop, so it acts rather than returning `tool_calls` — give it the same capabilities through `mcpServers` and the work still happens, just inside its loop. Tool calls and results already in the history are rendered faithfully |
| `response_format`, `n > 1`, `audio` | **400.** Nothing gives the caller its guarantee back |

Ignored parameters are never silent: they are logged once per (model, parameter)
and echoed back on the response as `x_acp2api.ignored`, which no client trips over
because everything reads `choices[0]`. Set `server.unsupportedParams` to `ignore`
to drop the reporting or `error` to refuse those too.

The ACP-native way to vary what a request cannot carry is **another agent entry**:
names are model ids, so "codex at low effort" is simply another model id.

Attachments work: an OpenAI `file` part with `file_data` becomes an ACP `resource`
block (text inline, anything else as a blob). `file_id` is refused — it names an
OpenAI-hosted file that does not exist here.

`model` and `reasoning` are matched by
[category](https://agentclientprotocol.com/protocol/session-setup), never by option
id, because the ids differ per agent — Claude calls its reasoning selector `effort`,
Codex calls it `reasoning_effort`. A `model` the agent does not offer is a **400**,
never a silent fallback: you named that agent to get that model.

To see what an agent offers, run its adapter and send `initialize` + `session/new`:

```sh
npx @agentclientprotocol/claude-agent-acp
```

## Run

```sh
acp2api --config acp2api.yaml --check   # validate and exit
acp2api --config acp2api.yaml
```

| route | |
| --- | --- |
| `GET /health` | no auth; lists the configured model ids |
| `GET /v1/models` | OpenAI model list |
| `POST /v1/chat/completions` | one turn; `stream: true` gives SSE |
| `POST /v1/responses` | one turn of a **retained conversation** |
| `GET /v1/responses/{id}` | a stored response |
| `DELETE /v1/responses/{id}` | forget it |

### Continuity: a stateless caller becomes a conversation

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

### Naming a conversation, when inferring it cannot work

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

### Saying something while the turn is still running

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

### Going quiet does not lose the work

A conversation nobody has continued past `sessionTtlMs` is **parked**, not ended:
it closes its ACP session — freeing the child process and the login it holds — and
keeps the session id. The next message restores it with `session/resume`, and the
agent still has every file it read and every plan it made.

```
fake: session conv_msp… parked: sess_01H…
fake: resumed sess_01H… [mattermost:channel:c8f3…]
```

So the bounds mean what they should: `maxSessions` caps resident sessions,
`sessionTtlMs` decides when to give one back, and `forgetTtlMs` — a day by default
— is what finally forgets a conversation. An agent that cannot resume is not a
problem: the revive fails and the caller gets a fresh session with its history
replayed, which is what would have happened anyway.

Two other things end a session. `maxContextFill` retires one that has used up its
context window, because the alternative is the agent's own compaction and then a
wall no retry gets past. And a turn nobody waited for — the caller hung up, or the
request timed out — no longer costs a **keyed** conversation its session: that is a
human redirecting the agent, not a broken agent.

### Starting warm instead of cold

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

### Watching a turn happen

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

### Running the agent's commands yourself

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

### /v1/responses is the better fit

The Responses API is stateful and so is ACP, which makes the mapping direct rather
than approximate:

| OpenAI | ACP |
| --- | --- |
| `previous_response_id` | a retained session — the agent's own memory of the turn |
| `instructions` | system preamble |
| `reasoning: {effort}` | the `thought_level` config option, **per request** |
| `max_output_tokens` | the same output-watching cut as `max_tokens` |
| `store: false` | close the session with the turn |

```sh
curl localhost:10021/v1/responses \
  -d '{"model":"claude-opus","input":"My favourite number is 41. Reply: noted"}'
# {"id":"resp_...","output_text":"noted", ...}

curl localhost:10021/v1/responses \
  -d '{"model":"claude-opus","input":"What was my number?","previous_response_id":"resp_..."}'
# "41"
```

The second request sends **only the new input**. Chat completions has to resend the
whole history each time and the agent reads it as one flattened transcript; here the
agent already holds it. `reasoning.effort` can likewise be raised for one hard
question mid-conversation and dropped again — chat completions has no field for that
at all.

Retained sessions are live child processes holding logins, so they are bounded by
`server.maxSessions` (evicted by last *use*, so an actively continued conversation
outlives a newer idle one) and `server.sessionTtlMs`. Both close the ACP session, as
do delete, shutdown, and a first turn that fails before answering.

There is no authentication: acp2api is a local bridge, and authorization is the
job of the router in front of it. It binds loopback by default and says so at
startup if you point `host:` somewhere else.

Agent *thinking* is streamed and returned as `reasoning_content` alongside
`content` — the non-standard-but-universal field vLLM, DeepSeek and OpenRouter all
use.

## Status codes, and why they matter

This is meant to sit in a **failover chain**, so the difference between "out of
quota" and "broken" is the contract:

| status | when |
| --- | --- |
| 429 | the agent reported a usage limit — *try the next one* |
| 502 | any other agent failure — a fault, not exhaustion |
| 503 | the CLI could not be spawned at all |
| 504 | the turn did not finish within `requestTimeoutMs` |
| 401 | the CLI is not logged in (ACP `auth_required`) |

ACP has **no quota error code** — agents surface exhaustion as a plain message — so
429 comes from matching `server.limitPatterns` against the error text. That list is
config, not code. An unrecognised message deliberately stays 502, because a router
must not spend its next provider on a crash it should have retried.

Two related traps this handles rather than inherits:

- **Streaming headers are held back** until the agent has actually started. Writing
  `200 text/event-stream` up front turns that 429 into a stream that merely stops,
  and the caller cannot tell the difference.
- **A cancelled turn is a normal ACP stop reason**, not an error. Passed through
  unexamined, a timeout returns `200` with whatever partial text existed.

## Develop

```sh
make test      # 183 tests, offline
make check     # validate the example config
make spec      # the code still carries every surface its .hint declares
make verify    # clean install + test + check + spec + pack
```

This repository is built with **[HINT](https://openhint.dev/)**, and most of it was
written by coding agents — the ones it exists to serve.

Every source file has a companion `.hint` beside it stating what that file owns:
its function contracts, its invariants, the test scenarios it must cover, and the
decisions that must not be relitigated — with the cross-cutting ones in the
folder-level [`_.hint`](_.hint). `hint <path>` returns the knowledge that applies
to a path, inheritance resolved, which is how an agent picks up the reasoning
behind code it is about to change instead of rediscovering it.

They are a contract, not documentation: `make spec` fails when the code drifts from
what its spec declares. Change a spec deliberately, then `hint lock` to record the
new snapshot.

It is also where the expensive lessons live. Every hard-won fact in this project —
that ACP defines no mid-turn input and `_session/steering` is the extension both
adapters implement, that an already-aborted `AbortSignal` never notifies a listener
added afterwards, that the MCP route must sit above any auth gate because the agent
carries no key — is written down next to the code it constrains, with what it cost
to learn. That is the whole point: the next agent to touch this reads it first, and
does not pay twice.

| file | |
| --- | --- |
| `src/config.js` | load, `${VAR}` expansion, validation, defaults |
| `src/params.js` | which OpenAI parameters are ignored, refused, or emulated, and why |
| `src/agent.js` | one ACP agent: spawn, initialize, session per turn, config options |
| `src/openai.js` | chat-completions ⇄ ACP translation, no I/O |
| `src/responses.js` | Responses API ⇄ ACP translation, and the typed event stream |
| `src/sessions.js` | retained conversations: lookup, TTL, LRU eviction, closing |
| `src/server.js` | HTTP routing, SSE, status mapping, the turn that outlives its request |
| `src/mcp.js` | the caller's tools, served to the agent as an MCP server |
| `test/fixtures/fake-agent.js` | a **real** ACP agent over real stdio |

The tests drive that fixture through an actual JSON-RPC handshake instead of mocking
the SDK, so they cover the wire format, `session/set_config_option`, streaming,
cancellation and the 429/502 split — offline, and without spending a subscription.

## Reference

- [Agent Client Protocol](https://agentclientprotocol.com) — the protocol
- [agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk) — the SDK this is built on
- [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) — the Claude adapter
- [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp) — the Codex adapter

## License

Apache-2.0
