# Operations

## Exposure and permissions

acp2api has no API authentication. It binds to loopback by default; put an
authenticating router or proxy in front before exposing it. CORS and Origin/Host
checks reduce browser and routing mistakes but are not authentication.

The spawned CLI uses its own existing login. acp2api does not read or replay OAuth
tokens and `--doctor` never performs login. Permission prompts are answered from
`server.permission`; there is no person at the terminal. Start with the agent's
least-permissive mode that can complete the intended work.

`server.cwd` bounds bridge-owned file callbacks and terminal working directories.
ACP supplies absolute paths; acp2api accepts them only when they resolve inside the
canonical workspace, and rejects traversal or symlink components that could escape
it. Relative paths remain accepted for compatible agents. This is not an OS
sandbox: the agent process may have its own filesystem/network access, and enabling
`server.terminal` moves command execution responsibility into the bridge. Use a
dedicated user, container or VM when hostile prompts/files are in scope.

## Preflight and diagnosis

```sh
acp2api --version
acp2api --init ./acp2api.yaml
acp2api --config ./acp2api.yaml --check
acp2api --config ./acp2api.yaml --doctor
acp2api --config ./acp2api.yaml --doctor --json
acp2api --config ./acp2api.yaml --probe my-agent
```

`--check` validates configuration only. `--doctor` creates configured workspaces,
resolves and starts each adapter, performs ACP `initialize` and `session/new`, then
applies the production option sequence: model first, followed by reasoning, mode
and raw option ids against each updated option list. This validates selectors that
appear or disappear after model selection. It also checks MCP transports against
advertised capabilities. Doctor does not warm a session or send a prompt. Findings
distinguish `login_required`, `model_unavailable`, `no_mcp_transport`,
`cli_not_installed`, and `could_not_verify`; any finding exits 2. `--probe` prints
one agent's initial option/capability vocabulary without applying its configured
options, for deeper diagnosis.

## State, limits and restart

Conversations and stored Responses are in memory. A restart forgets them, so a
later `previous_response_id` returns 404. TTL is checked before refresh: reading an
expired id does not revive it. Resident sessions, retained conversations, response
count and serialized response bytes are separate limits; see the commented
defaults in `acp2api.example.yaml` for the current names and values.

Parking closes an ACP session, not the shared child process. Resume depends on the
agent retaining that session id and accepting the same cwd and complete MCP set.
If it cannot be recovered, continuation fails closed instead of silently starting
without history.

## Timeouts, cancellation and retries

`requestTimeoutMs` caps a turn; `agentRpcTimeoutMs` caps setup/control calls;
`toolTimeoutMs` caps a caller tool waiting for its result. Client disconnects and
timeouts cancel the turn and retire unsafe session state. Cancellation is
cooperative, so the CLI may emit briefly while cleanup drains it.

Automatic retries need application judgment. Before streaming headers, an
exhaustion match is an HTTP 429 suitable for provider failover. After headers, HTTP
status cannot change. Retrying a tool-heavy turn can execute file writes, commands
or external tool calls twice; use stable conversation/call ids and make side
effects idempotent where possible.

## Proxy and container notes

- Keep the acp2api listener private and terminate authentication at the proxy.
- Preserve the configured Host and explicitly allow browser origins; do not rely
  on `X-Forwarded-*` to authorize a request.
- Send `Content-Type: application/json` on inference POSTs.
- In Docker, bind acp2api to `0.0.0.0` inside the container but publish the port to
  host loopback. Add the published authority, including its external port, to
  `server.allowedHosts` (for example `localhost:10021` and
  `127.0.0.1:10021`). The container's socket address is different from the
  client-visible `Host`, so `host: 0.0.0.0` alone deliberately does not authorize
  it. Mount the workspace and the CLI's login directory for the same container
  user.
- Give remote HTTP/SSE MCP servers only to agents whose doctor output advertises
  that transport. ACP stdio MCP does not require a capability flag.

Metrics are unauthenticated too. `metricsAddr` is a distinct exposure decision;
bind it only where the scraper can reach it.
