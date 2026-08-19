# acp2api

[![ci](https://github.com/neprel/acp2api/actions/workflows/ci.yml/badge.svg)](https://github.com/neprel/acp2api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/acp2api)](https://www.npmjs.com/package/acp2api)
[![node](https://img.shields.io/node/v/acp2api)](https://www.npmjs.com/package/acp2api)
[![license](https://img.shields.io/npm/l/acp2api)](LICENSE)
[![built with HINT](https://img.shields.io/badge/built_with-HINT-5b4ee6)](https://openhint.dev/)

**Use Claude Code, Codex or any [ACP](https://agentclientprotocol.com) agent from
anything that speaks the OpenAI API.** Each agent you configure becomes a
**model id** — that is the whole interface.

```
   OpenAI client                acp2api                  ACP agent
  (Hermes, LangChain,   ──▶  /v1/chat/completions  ──▶  claude-agent-acp
   OpenWebUI, a router,       OpenAI  ⇄  ACP            codex-acp
   your own script)                                     opencode acp, …
```

It spawns the CLI you are already logged into and spends **that subscription** —
no API key is read, replayed or forwarded. That is the point, and the reason
this goes through ACP instead of borrowing a vendor's OAuth token for its
private HTTP API: the CLI uses the login it already has, and nothing else.

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
curl localhost:10021/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-opus","messages":[{"role":"user","content":"what is in this repo?"}]}'
```

That is a working install. There is **no authentication**: acp2api listens on
loopback and authorization belongs to whatever router sits in front.

## What it gives you

A coding-agent turn runs for minutes, holds state you paid for, narrates
itself, runs commands — and an OpenAI client knows none of that. Everything
below makes one behave sensibly anyway; each link has the request that
exercises it, in [the guide](docs/guide.md).

| | what it solves |
| --- | --- |
| [**Conversations, not cold starts**](docs/guide.md#continuity-a-stateless-caller-becomes-a-conversation) | replaying a transcript per message throws away everything the agent had learned; incoming histories match live sessions by prefix |
| [**Naming a conversation**](docs/guide.md#naming-a-conversation-when-inferring-it-cannot-work) | one `x-conversation-id` header keeps one agent session per chat thread, for callers with no growing prefix to match |
| [**Steering a running turn**](docs/guide.md#saying-something-while-the-turn-is-still-running) | deliver a correction INTO a turn that has nineteen minutes left |
| [**Parking, not forgetting**](docs/guide.md#going-quiet-does-not-lose-the-work) | an idle thread gives back its process and keeps its memory (`session/resume`) |
| [**Warm starts**](docs/guide.md#starting-warm-instead-of-cold) | one warm-up forked per conversation instead of a re-orientation per thread |
| [**Watching the work**](docs/guide.md#watching-a-turn-happen) | tool calls, diffs and plans on `reasoning_content`, so a long turn stops looking like a hang |
| [**Running commands yourself**](docs/guide.md#running-the-agents-commands-yourself) | ACP `terminal`: execution in your process, with your bounds |
| [**Your tools, in the agent's hands**](docs/guide.md#your-tools-in-the-agents-hands) | OpenAI `tools` in, `tool_calls` back — served to the agent as an MCP server, the turn held open for your result |
| [**The agent's own tools**](docs/guide.md#the-agents-own-tools-come-from-mcp) | `mcpServers` per agent; it acts instead of asking |
| [**Honest parameters**](docs/guide.md#what-openai-parameters-do) | split by *what breaks if we proceed*: emulated, ignored-and-reported, or a clean 400 |
| [**`/v1/responses`**](docs/guide.md#v1responses-is-the-better-fit) | the stateful API maps onto ACP directly: `previous_response_id`, per-request `reasoning.effort` |

## Which agents work

Measured, not inferred: all **38 registry agents** were installed and driven on
2026-08-14 — full results in [docs/agents.md](docs/agents.md). Verified end to
end (real turn, own file tools, MCP, streaming, continuity):

| agent | run as |
| --- | --- |
| **Claude Code** | `type: claude` (steerable) |
| **Codex** | `type: codex` (steerable) |
| **OpenCode** | `command: opencode`, `args: [acp]` |
| **Qwen Code** | `npx @qwen-code/qwen-code --acp` + `OPENAI_BASE_URL/KEY/MODEL` |
| **goose** | `goose acp --with-builtin developer` |

Most of the rest are account-gated (sign the CLI in once and they work) or need
a model configured; a handful cannot finish a turn — each with the reason
recorded.

## Configure

One YAML file, `${VAR}` expanded from the environment; every option documented
in [`acp2api.example.yaml`](acp2api.example.yaml). The essentials:

| key | meaning |
| --- | --- |
| `type` | `claude` / `codex` bundle an adapter; `general` needs `command` |
| `model`, `reasoning` | set by semantic **category** (`model`, `thought_level`) — ids differ per agent |
| `mcpServers` | the agent's tools (`url`+`headers` or `command`+`args`+`env`) |
| `env`, `cwd`, `args` | per-agent spawn overrides |
| `server.*` | continuity, conversation header, steering (`busy: queue`), session bounds, progress, terminal |

```sh
acp2api --config acp2api.yaml --check   # validate and exit
```

Routes: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (SSE with
`stream: true`), `POST/GET/DELETE /v1/responses`.

## Status codes — the failover contract

This is built to sit in a failover chain; the difference between "out of quota"
and "broken" is the contract:

| status | when |
| --- | --- |
| 429 | the agent reported a usage limit — *try the next one* (matched via `server.limitPatterns`; ACP has no quota code) |
| 502 | any other agent failure — a fault, not exhaustion |
| 503 | the CLI could not be spawned |
| 504 | the turn outlived `requestTimeoutMs` |
| 401 | the CLI is not logged in |

Streaming headers are held back until the agent actually starts, so a 429
stays a 429 instead of a stream that merely stops.

## Develop

```sh
make test      # 183 tests, offline, against a real stdio fake agent
make check     # validate the example config
make spec      # the code still carries every surface its .hint declares
make verify    # clean install + test + check + spec + pack
```

Built with **[HINT](https://openhint.dev/)**, mostly by the coding agents it
exists to serve: every source file has a companion `.hint` with its contracts,
invariants and the expensive lessons (`hint <path>` to read them, `make spec`
fails on drift).

## Reference

- [Agent Client Protocol](https://agentclientprotocol.com) — the protocol
- [typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk) · [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) · [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- [the guide](docs/guide.md) — every feature, with the request that exercises it
- [which agents work](docs/agents.md) — the measured 38-agent survey

## License

Apache-2.0
