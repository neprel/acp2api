# acp2api

**An OpenAI-compatible HTTP server in front of [ACP](https://agentclientprotocol.com) agents.**

Plenty of tools speak the OpenAI API and would very much like to drive a coding
agent like Claude Code or Codex — but do not speak
[ACP](https://agentclientprotocol.com) yet. Hermes is a good example: it can already
run *as* an ACP server for editors, while a generalized ACP *client* is still an
open request ([#5257](https://github.com/NousResearch/hermes-agent/issues/5257),
[#36057](https://github.com/NousResearch/hermes-agent/issues/36057)).

`acp2api` closes that gap from the other side. It speaks ACP to the agents and the
OpenAI API to everyone else, so anything that can already POST to
`/v1/chat/completions` gets ACP agents today:

```
POST /v1/chat/completions   {"model": "claude-opus", "messages": [...]}
```

Every agent you configure becomes an OpenAI **model id**. That is the whole
interface.

```
   OpenAI client                acp2api                  ACP agent
  (Hermes, LangChain,   ──▶  /v1/chat/completions  ──▶  claude-agent-acp
   OpenWebUI, a router,       OpenAI  ⇄  ACP            codex-acp
   your own script)                                     opencode acp, cline --acp, …
```

## Why go through ACP at all

The CLI is **spawned** and uses the subscription it is already logged into
(`~/.claude`, `~/.codex`). No OAuth token is read, replayed, or forwarded — which
is the point. The other way to build this is to borrow the vendor's token and call
the vendor's private HTTP API; that yields nicer error handling and is not yours to
do.

The cost of the honest branch is that everything must fit through ACP's stdio
JSON-RPC. That turns out to be enough: `session/set_config_option` exposes both the
model selector and the reasoning level, so an agent is fully specified from config.

## Install

```sh
npm install -g acp2api
```

The [Claude](https://github.com/agentclientprotocol/claude-agent-acp) and
[Codex](https://github.com/agentclientprotocol/codex-acp) adapters come bundled as
optional dependencies. Skip them with `--omit=optional` if you only need `general`
agents. Log the CLIs in as usual (`claude`, `codex login`) — acp2api never handles
credentials.

## Configure

One YAML file. `${VAR}` and `${VAR:-default}` expand from the environment. Start
from [`acp2api.example.yaml`](acp2api.example.yaml).

```yaml
server:
  host: 127.0.0.1
  port: 10021
  apiKey: ${ACP2API_API_KEY}   # what CLIENTS send; not a vendor key
  cwd: ./work                  # session workspace and fs sandbox
  permission: allow            # how to answer session/request_permission
  requestTimeoutMs: 900000

agents:
  - name: claude-opus          # <- the OpenAI model id
    type: claude               # claude | codex | general
    model: opus[1m]
    reasoning: high
  - name: opencode
    type: general              # anything else that speaks ACP
    command: opencode
    args: [acp]
```

| key | meaning |
| --- | --- |
| `type` | `claude` and `codex` bundle an adapter; `general` needs `command` |
| `model` | set on the config option whose **category** is `model` |
| `reasoning` | set on the config option whose **category** is `thought_level` |
| `options` | `{configId: value}` for anything else the agent exposes |
| `mcpServers` | tools for this agent — see below |
| `env`, `cwd`, `args` | per-agent spawn overrides |

### Tools come from MCP, not from `tools`

An ACP agent runs its **own** tool loop, so there is no per-request `tools` array to
honour. Tools are a property of the agent, declared when its session opens:

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
| `POST /v1/chat/completions` | one stateless turn; `stream: true` gives SSE |
| `POST /v1/responses` | one turn of a **retained conversation** |
| `GET /v1/responses/{id}` | a stored response |
| `DELETE /v1/responses/{id}` | forget it |

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
curl localhost:10021/v1/responses -H "authorization: Bearer $KEY" \
  -d '{"model":"claude-opus","input":"My favourite number is 41. Reply: noted"}'
# {"id":"resp_...","output_text":"noted", ...}

curl localhost:10021/v1/responses -H "authorization: Bearer $KEY" \
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

Auth is `Authorization: Bearer <apiKey>` or `x-api-key`. An empty `apiKey` disables
it, and the server says so on startup.

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
make test      # 96 tests, offline
make check     # validate the example config
make spec      # the code still carries every surface its .hint declares
make verify    # clean install + test + check + spec + pack
```

Every source file has a companion `.hint` next to it stating what that file owns,
its function contracts, its invariants, and the test scenarios it must cover — with
the cross-cutting decisions in the folder-level [`_.hint`](_.hint). They are the
contract, not documentation: `make spec` fails when the code drifts from them.
Change a spec deliberately, then re-run `hint lock` to record the new snapshot.

| file | |
| --- | --- |
| `src/config.js` | load, `${VAR}` expansion, validation, defaults |
| `src/params.js` | which OpenAI parameters are ignored, refused, or emulated, and why |
| `src/agent.js` | one ACP agent: spawn, initialize, session per turn, config options |
| `src/openai.js` | chat-completions ⇄ ACP translation, no I/O |
| `src/responses.js` | Responses API ⇄ ACP translation, and the typed event stream |
| `src/sessions.js` | retained conversations: lookup, TTL, LRU eviction, closing |
| `src/server.js` | HTTP routing, auth, SSE, status mapping |
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
