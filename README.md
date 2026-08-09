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
| `env`, `cwd`, `args` | per-agent spawn overrides |

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
| `POST /v1/chat/completions` | `stream: true` gives SSE |

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
make test      # 48 tests, offline
make check     # validate the example config
make verify    # clean install + test + check + pack
```

| file | |
| --- | --- |
| `src/config.js` | load, `${VAR}` expansion, validation, defaults |
| `src/agent.js` | one ACP agent: spawn, initialize, session per turn, config options |
| `src/openai.js` | OpenAI ⇄ ACP translation, no I/O |
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
