# Which agents work

Every agent in the [ACP registry](https://agentclientprotocol.com/get-started/registry)
— 38 of them, installed from the registry's own `npx` / `uvx` / signed-binary entry
and started with the registry's own argv — was asked two questions on 2026-08-14:
does it complete `initialize` and `session/new`, and does a real turn come back
through this bridge. Everything below is measured, on Linux x86_64, against one
local OpenAI-compatible endpoint. Nothing is inferred from a README.

**Verified end to end** — a real turn, the agent's own file tools, an MCP server
this bridge handed to `session/new`, streaming with the trace separated into
`reasoning_content`, and prefix continuity. All five:

| agent | run as | notes |
| --- | --- | --- |
| **Claude Code** | `type: claude` | the reference agent, and one of the three that can be steered |
| **Codex** | `type: codex` | steering too |
| **OpenCode** 1.18.18 | `command: opencode`, `args: [acp]` | `model` and `mode` selectors; no steering |
| **Qwen Code** 0.21.11 | `npx @qwen-code/qwen-code --acp` | `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL` |
| **goose** 1.46.0 | `goose acp --with-builtin developer` | see below — without that flag it has no tools at all |

Two things worth knowing before picking one of the last two. goose ships **no tools
until an extension is enabled**: a plain `goose acp` can talk and can use your MCP
servers, but cannot read a file. And goose fans out — one tool-heavy turn put four
concurrent requests on the model server, which is unremarkable against a hosted API
and can be too much for a small local one.

**Signs in, then works.** The handshake is clean and `session/new` is refused until
the CLI's own account is signed in. None of this is a bridge problem: run the CLI's
login once, in the same container, and it behaves like any other agent.

| agent | what it wants |
| --- | --- |
| GitHub Copilot 1.0.80 | `copilot-login` — included in every Copilot plan, Free included |
| Cursor 2026.08.11 | `agent login`, then `authenticate` with `cursor_login` |
| Factory Droid 0.196.0 | device pairing, or `FACTORY_API_KEY` |
| Kimi CLI 1.49.0 | `kimi login` |
| Qoder CLI 0.2.14 | login or a personal access token |
| Grok Build, DimCode, Codebuddy, Corust, Autohand, Stakpak | their own account |
| Cline 3.0.55 | a **Cline account** — and configuring a model provider does *not* satisfy it. Its ordinary CLI answers happily through a local endpoint; only the ACP path is gated |
| Auggie CLI 0.35.0 | `auggie login`; it says outright that it cannot authenticate over ACP |

**Needs a model, not an account.** `session/new` fails with a configuration error
and the fix is an environment variable or a config file: goose (`GOOSE_PROVIDER`),
Gemini CLI (a Gemini key — the free Google-login tier ended 2026-06-18), Mistral
Vibe (a Mistral key), crow-cli (`crow init`), Nova, pi ACP, Agoragentic.

**Opened a session but could not finish a turn**, each for its own reason:

| agent | what happened |
| --- | --- |
| VT Code 0.96.14 | calls `POST /v1/responses` — the Responses API, which many OpenAI-compatible servers do not implement |
| Kilo 7.4.22 | ignores `OPENAI_BASE_URL` and calls Kilo's own cloud; its 357 models are all `kilo/…` |
| siGit Code 1.5.2 | honours the base URL but not the model: the selector offers 14 fixed GGUF names, so an arbitrary served model cannot be addressed |
| GLM Agent 1.3.0 | wants `Z_AI_API_KEY`; no base-URL override |
| DeepAgents 0.1.7 | its npx package cannot resolve `@langchain/anthropic` at runtime |
| Dirac 0.4.36 | accepts the prompt and never answers — three minutes, no error |
| Harn 0.10.92 | not a coding CLI at all: a harness *language*, whose ACP transport expects a `.harn` program |
| fast-agent 0.10.1, Minion Code 0.1.44 | exit 1 under `uvx`, before the handshake |
| Cortex Code, Poolside | the registry's own download URL answers 403 |

**Three protocol notes from the same run.**

*Steering is rare.* `_session/steering` — the extension that `server.busy: queue`
and [steering](guide.md#saying-something-while-the-turn-is-still-running) are built on — is
advertised by **three of thirty-eight**: Claude Agent, Codex and JetBrains Junie.
For every other agent a mid-turn message cannot be delivered into the running turn,
and the bridge reports that rather than pretending otherwise.

*Read an agent's config options before setting them.* `model`, `thought_level` and
`mode` are the categories this bridge addresses, and agents differ in which they
publish: OpenCode has `model` and `mode` but only grows a `thought_level` when the
selected model declares reasoning support; VT Code has `mode` and `thought_level`
and no `model` at all; Claude Agent adds `model_config`. A value the agent does not
offer comes back as a 400 naming the option, never as a silent default.

*MCP transports are not negotiated.* Agents advertise `mcpCapabilities.http` and
`.sse` at `initialize`, and several advertise neither. This bridge passes every
configured server to `session/new` regardless. If your agent is stdio-only, give it
stdio servers.
