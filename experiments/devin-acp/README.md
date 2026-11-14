# Devin CLI ACP and login probes

[`probe.ts`](probe.ts) runs an isolated zero-token CLI and ACP handshake check against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-13. [`login-probe.ts`](login-probe.ts) runs an isolated CLI login, `auth status`, and `logout` check against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-14 with an in-process dual-stack `localhost` synthetic PKCE and ConnectRPC server. Both scripts create temporary directories with `mkdtempSync`, isolate `HOME` and `XDG_*` paths, remove their temporary directories on exit, and touch no host configuration, stored credentials, browser, or model quota.

## Observed handshake results

| Check | Measured result on `devin 3000.12.57` |
| --- | --- |
| `devin --version` | Exits `0` and prints `devin 3000.12.57 (96542e930752)`. |
| `devin auth status` in clean `HOME` | Exits `0` and prints `Not logged in.`, `Credentials path: ...`, and `Run 'devin auth login' to authenticate.` with backticks around the command. |
| `devin auth status` with synthetic `WINDSURF_API_KEY` | Exits `0`, prints the same `Not logged in.` output, and ignores `WINDSURF_API_KEY`. |
| `devin auth status` with corrupt `credentials.toml` | Exits `0` and prints `Failed to load credentials: TOML parse error ...`. |
| ACP `initialize` on bare `devin acp` | Opens in an untrusted temporary `cwd` without `--permission-mode` or `--respect-workspace-trust`. Reports `protocolVersion: 1`, `agentInfo.name: "affogato"`, `loadSession: true`, `promptCapabilities` for `image` and `embeddedContext` with `audio: false`, `mcpCapabilities` for `http` and `sse`, `sessionCapabilities` for `list`, `delete`, `additionalDirectories`, and `close`, `_meta["cognition.ai/midTurnPrompts"]: true`, and `authMethods` for `devin-browser`. |
| ACP `session/new` while logged out | Opens in `accept-edits` mode and lists `accept-edits`, `smart`, `ask`, `plan`, and `bypass` in `modes.availableModes` and `configOptions`. `model` has `currentValue: "swe-1-6-fast"` and `options: []`. `available_commands_update` lists 22 slash commands without an account quota or limit-reset query. |
| ACP `session/set_mode` to `"bypass"` | Returns `{}`. |
| ACP `session/set_model` | Fails with JSON-RPC `-32601` and `Method not found`. Model switching uses `session/set_config_option`. |
| ACP `session/list` and `session/delete` | `session/new` appears in `session/list` while open, and `session/delete` returns `{}` and clears the entry from both `session/list` and `$XDG_DATA_HOME/devin/cli/sessions.db`. |
| ACP `session/load` on missing session ID | Fails with JSON-RPC `-32016`, `Session not found`, and `data["cognition.ai/errorKind"] = "session_not_found"`. |

## Observed synthetic PKCE login, status, and logout results

`login-probe.ts` points `DEVIN_WEBAPP_URL`, `DEVIN_API_URL`, `WINDSURF_API_SERVER_URL`, and `WINDSURF_WEBSITE_URL` at `http://localhost:<port>` and places sentinel `open` and `xdg-open` shims first on `PATH`. An interactive `tuistory` terminal recording on macOS arm64 confirmed the same sequence through both the 3-way `devin auth login` selector and `devin auth login --force-manual-token-flow`.

| Check | Measured result on `devin 3000.12.57` |
| --- | --- |
| Detached non-TTY `devin auth login --force-manual-token-flow` | Prints the `cli_pkce_marker=1` URL when `/api/healthz` returns `"OK"`, opens `/dev/tty` directly through `crossterm`, ignores piped stdin, exits `1` with `Error: Failed to read code - user canceled` on stderr, and launches zero browsers. |
| PTY `devin auth login --force-manual-token-flow` | Prints the `cli_pkce_marker=1` URL with `code_challenge_method=S256` without launching a browser, accepts the pasted code at the masked `Code:` prompt, posts `{ code, code_verifier }` to `/auth/cli/token` matching `SHA256(code_verifier) === code_challenge`, calls ConnectRPC `GetUserStatus`, writes `$XDG_DATA_HOME/devin/credentials.toml`, and prints `Login successful! Credentials stored.`. |
| Authenticated `devin auth status` | Exits `0` and prints `Logged in (via Devin).` or `Logged in (via API key).` followed by `Credentials:`, `User:`, `Account:`, and `Team settings:`. `parseDevinAuthStatus` extracts `method`, `credential`, `email`, and `plan` while omitting `File:`, `Name:`, `User ID:`, `Team ID:`, `Primary org:`, and server URLs. |
| Empty `Email:` or `Plan:` in `GetUserStatus` | Omits the empty `Email:` or `Plan:` line. When `Name`, `Email`, and `User ID` are all empty, `User:` prints `(no user details returned by server)`. |
| Re-running `devin auth login --force-manual-token-flow` with `credentials.toml` | Exits `0` with `You are already logged in. Use 'devin auth logout' first to re-authenticate.` both when `GetUserStatus` succeeds and when `GetUserStatus` rejects the stored key with HTTP `401`, while `devin auth status` reports `logged_out` on the `401`-rejected key. |
| `devin auth logout` | Deletes `$XDG_DATA_HOME/devin/credentials.toml`, exits `0` with `Logged out successfully`, and leaves subsequent `devin auth status` at `Not logged in.`. |

Additional isolated CLI and binary checks on `devin 3000.12.57` established these vendor behaviors:

- `WINDSURF_API_KEY` is the sole environment credential that `devin acp` reads. `DEVIN_API_KEY` does not appear in the binary, and `devin` ignores it.
- `session/new` with an invalid `WINDSURF_API_KEY` or an invalid stored key fails with JSON-RPC `-32603`, no `data` payload, and `Failed to load team settings: Failed to fetch team settings: Authentication required: invalid api key`.
- Logged-out `session/prompt` emits `_cognition.ai/agent_stopped` with `cause: "auth_required"` and fails with JSON-RPC `-32000` and `Please log in to use Devin.`.
- `User / team info:` in `devin auth status` appears only when `GetUserStatus` fails after loading `$XDG_DATA_HOME/devin/credentials.toml`. It prints `Failed to fetch from server: Authentication required: invalid api key` on a rejected key and `Failed to fetch from server:` or `Unavailable:` when the server check cannot complete.
- `devin auth login` without `--force-manual-token-flow` blocks on a 3-way `ratatui` mode selector over pipes without printing a URL, and browser login invokes `/usr/bin/open` directly on macOS through `open-5.3.3` without consulting `BROWSER` or `PATH`.
- `GET /api/healthz` on `DEVIN_WEBAPP_URL` must return HTTP `200` JSON `"OK"`, or else `devin auth login` falls back to `windsurf.com` login and invokes `/usr/bin/open` even under `--force-manual-token-flow`. `windsurf-api-client` rewrites the first dot-separated label of a host to `api.`, which turns `127.0.0.1` into `api.0.0.1` while keeping `localhost:<port>` intact.
- ACP `authenticate` with `{ methodId: "devin-browser" }` opens a loopback callback, invokes `/usr/bin/open` directly without emitting a sign-in URL over ACP, and fails with JSON-RPC `-32603` and `Could not open browser for authentication` when the environment blocks `/usr/bin/open`.
- `session/load` on an existing session emits `session_info_update`, `available_commands_update`, and message-cluster replay `session/update` notifications before returning its RPC result.
- `session/list` records each session's original `cwd`, and `resume` keeps that saved `cwd`.
- `devin update` prompts for confirmation without a `--yes` flag.
- `devin models list` prints variant IDs that ACP `session/set_config_option` rejects with JSON-RPC `-32602` and `Invalid params`.
- `devin doctor --json` checks subagent profiles and OpenTelemetry settings without account quota windows.
- Devin writes no HTTP or stdio MCP environment variables or credentials to SQLite under `$XDG_DATA_HOME/devin`.
- `devin acp` speaks ConnectRPC protobuf with `Content-Type: application/proto` on `/exa.*` routes such as `GetUserStatus`, `GetCliTeamSettings`, `GetCliModelConfigs`, `AssignModel`, and `GetChatMessage` rather than OpenAI or Anthropic HTTP, so OAR wires no `aimock` sea-trial backend.

## Reproduce

```sh
pnpm exec tsx experiments/devin-acp/probe.ts
pnpm exec tsx experiments/devin-acp/login-probe.ts
```

Set `OAR_DEVIN_BIN=/path/to/devin` when `devin` is neither on `PATH` nor at `~/.local/bin/devin`.
