# Migration notes

## From 1.16.0 to 1.16.1

This patch release corrects and completes the user documentation and narrows the
published examples glob so generated Python cache files cannot enter the package.
It does not change the runtime API or configuration behavior.

## From 1.15.x to 1.16.0

The changes below intentionally replace behaviours that could return a successful
but incorrect result.

- Responses continuation is linear. Continue only from the latest id. A known
  older id now returns 409; an unknown, expired or failed-resume id returns 404.
- Failed resume no longer falls back to a cold session. Callers must start an
  explicit new chain if losing history is acceptable.
- A failed, timed-out or disconnected continued turn invalidates its old response
  id after the prompt starts; it cannot be reused as if the failed input had never
  reached the agent.
- Validation that fails before a prompt or matching tool result is sent now leaves
  the latest response id usable after correction. It does not consume or corrupt
  the continuation claim.
- Changing, adding or removing `instructions` during a chain is refused. Start a
  new response without `previous_response_id` to change them.
- `store: false` creates no retrievable new response or continuation tip. When it
  continues a stored chain, the result is returned, older GET snapshots remain
  readable, and the chain is closed so those ids cannot be continued.
- `tool_choice: "required"`, named tool selection, `strict: true`, and unsupported
  tool types are refused. `tool_choice: "none"` now actually withholds caller
  tools; `"auto"` remains supported.
- Chat accepts `reasoning_effort` when the selected agent exposes a
  `thought_level` option. Responses continues to use `reasoning.effort`. A
  request-level override is reset to the baseline derived after configured model
  and raw options; parking/resume preserves that baseline.
- Stop strings choose the earliest occurrence in generated text, independent of
  array order. Token limits remain an approximate visible-text bound.
- JSON inference POSTs require `Content-Type: application/json`. Requests with an
  untrusted Origin or Host are rejected before an agent is spawned.
- ACP absolute file paths inside the canonical workspace are accepted; paths
  outside it, traversal and symlink components are refused. Root-level workspace
  files can be created and overwritten. The boundary is still not an OS sandbox;
  isolate the process for adversarial workloads.
- Response/session retention is bounded and periodically cleaned. A process
  restart still forgets all in-memory ids.
- Responses streaming uses canonical item ids/indexes and function-call argument
  events. Consumers that parsed earlier non-canonical event sequences should use
  the official SDK or update their parser.
- Standalone or unknown Responses `function_call_output` ids are refused. A
  Responses request that combines tool results with new message input is refused
  rather than dropping the message; send the result and the next message in
  separate requests.
- Responses continuation ownership is exclusive. A concurrent continuation or
  duplicate `function_call_output` receives 409 `conversation_busy` without
  changing the first request; the winning request can finish and continue.

New operator commands are `--version`, `--init <file>`, and `--doctor [--json]`.
`--init` never overwrites. Run doctor before rollout; it performs setup and applies
the configured model/options in a disposable session, including selectors that
change after model selection, but spends no prompt turn and does not change login.

Review the [compatibility matrix](compatibility.md) for parameter-level behavior
and [operations](operations.md) before exposing a listener or enabling retries.
