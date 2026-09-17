# Compatibility matrix

acp2api implements a deliberately bounded OpenAI-compatible surface over ACP. It
is not a drop-in implementation of every OpenAI endpoint or parameter.

Status terms used below:

- **supported** — represented on the ACP path and covered by an offline test;
- **emulated** — implemented by the bridge, with the stated semantic limit;
- **ignored** — accepted and reported in `x_acp2api.ignored`;
- **refused** — rejected with an OpenAI-shaped 4xx error rather than guessed.

## Endpoints and streaming

| Surface | Status | Notes / evidence |
| --- | --- | --- |
| `GET /health`, `GET /v1/models` | supported | startup and HTTP coverage in `test/server.test.js` |
| `POST /v1/chat/completions` | supported subset | non-streaming and SSE, ending in `[DONE]` |
| `POST /v1/responses` | supported subset | non-streaming and official Responses SSE events |
| `GET /v1/responses/:id` | supported | stored responses only |
| `DELETE /v1/responses/:id` | supported | releases retained state when applicable |
| Other OpenAI endpoints | refused/not routed | no embeddings, images, audio, files, batches or fine-tuning API |

Both streaming APIs delay HTTP 200 until the first event. An error before that
remains an HTTP error such as 401, 429, 502, 503 or 504. After headers, failures are
reported in the stream and cannot be promised as HTTP 429.

## Requests

| Feature | Chat Completions | Responses |
| --- | --- | --- |
| model id | supported: configured agent `name` | supported |
| text messages | supported | string input, message items, `input_text` and returned `output_text` supported |
| roles | system, developer, user, assistant, tool | system, developer, user, assistant; function results use typed items |
| images | base64 data URI supported when the agent advertises image prompts | `input_image` base64 data URI supported with the same capability |
| remote image URL / `file_id` | refused | refused; the bridge never downloads it implicitly |
| inline file data | `file`/`input_file` with a `file_data` data URI supported when the agent advertises embedded context | `input_file` with a `file_data` data URI supported with the same capability |
| `reasoning_effort` / `reasoning.effort` | supported when the agent advertises `thought_level` | supported per turn |
| `max_tokens` / `max_output_tokens` | emulated | emulated |
| `stop` | emulated, earliest match wins | no Responses stop field |
| sampling (`temperature`, `top_p`, seed, penalties) | ignored and reported | unknown non-contract fields ignored and reported |
| nested request fields | known shapes validated; unsupported tool guarantees refused | unknown `reasoning.*` fields ignored and reported by dotted path; tool definitions validated/refused |
| structured output, audio, `n > 1` | refused | structured output/audio refused |

Token limits are approximately four Unicode characters per token and cancel the
ACP turn after the visible bound is reached. They are not tokenizer-accurate spend
limits. Usage is present only when the agent reports ACP usage; missing usage means
unknown, not zero.

Inline file data becomes an ACP resource block: text remains inline and other MIME
types become blobs. `file_id` and remote file URLs are refused because the bridge
does not fetch OpenAI-hosted or arbitrary remote content.

## Tools and state

Function tools are supported through a per-conversation MCP server. Only
`tool_choice: "auto"` and `"none"` are honest: `"required"`, named selection,
non-function tools, and `strict: true` are refused because ACP cannot provide those
guarantees. `"none"` prevents caller tools from being exposed on that turn.

Chat returns `tool_calls`; Responses returns `function_call` items and streaming
argument events. A result must carry the matching live call id; standalone or
unknown results are refused before a prompt starts. A Responses request that mixes
`function_call_output` with new message input is also refused, so the new input is
never silently discarded—resolve the call first, then send the message. Agent-owned
`mcpServers` remain separate from caller tools.

Responses continuation is a linear chain. Only the latest stored response id may
continue it: a known older id is `409 stale_previous_response`; an unknown, expired
or unrecoverable id is `404 not_found`. Unchanged explicit `instructions` may
continue. Adding, changing or removing them in a live chain is refused because a
text preamble cannot erase instructions already in ACP history. `store: false`
returns a result but creates no continuation point.
If a continued turn fails, times out or disconnects after its prompt began, the
old response id is invalidated: the ACP history changed without a successful new
continuation point, so retrying from the old id returns 404.

## Output semantics

ACP answer text becomes Chat `content` or Responses `output_text`. Agent thinking
and bridge progress are exposed as compatibility extensions where enabled; they
are not guaranteed to be a genuine OpenAI reasoning summary.

| ACP stop reason | Chat `finish_reason` | Responses result |
| --- | --- | --- |
| `end_turn` | `stop` | `completed` |
| `max_tokens` / bridge visible-text limit | `length` | `incomplete`, reason `max_output_tokens` |
| `refusal` | `content_filter` | `incomplete`, reason `content_filter` |
| `cancelled` | `stop` plus `x_acp2api.stop_reason`, when returned as an ordinary agent result | `cancelled` |
| `max_turn_requests` | `length` | `incomplete`, reason `max_output_tokens`, plus `x_acp2api.stop_reason` |
| unknown future value | `stop`, plus `x_acp2api.stop_reason` | `completed`, plus `x_acp2api.stop_reason` |

The extension preserves the source reason only when the public mapping is lossy;
it does not invent an OpenAI enum. A bridge timeout remains HTTP 504 before
streaming rather than being disguised as an ordinary `cancelled` result. Refusals,
incomplete output, function calls and reported usage have dedicated tests in
`test/server.test.js`, `test/responses.test.js`, and `test/sdk/sdk.test.js`.

Agent capabilities vary independently of this matrix. Run `acp2api --doctor` for
the configured fleet and see [agents.md](agents.md) for dated observations.
