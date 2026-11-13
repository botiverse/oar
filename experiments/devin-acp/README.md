# Devin CLI ACP probe

[`probe.ts`](probe.ts) runs an isolated zero-token check against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-13. The script creates a temporary directory with `mkdtempSync`, isolates `HOME` and `XDG_*` paths, removes the directory on exit, and touches no user configuration, stored credentials, or model quota.

## Observed results

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

Additional isolated CLI and binary checks on `devin 3000.12.57` established these vendor behaviors:

- `WINDSURF_API_KEY` is the sole environment credential that `devin acp` reads. `DEVIN_API_KEY` does not appear in the binary, and `devin` ignores it.
- `session/new` with an invalid `WINDSURF_API_KEY` or an invalid stored key fails with JSON-RPC `-32603`, no `data` payload, and `Failed to load team settings: Failed to fetch team settings: Authentication required: invalid api key`.
- Logged-out `session/prompt` emits `_cognition.ai/agent_stopped` with `cause: "auth_required"` and fails with JSON-RPC `-32000` and `Please log in to use Devin.`.
- When `$XDG_DATA_HOME/devin/credentials.toml` exists, `devin auth status` exits `0` and prints `Logged in (via Devin).` or `Logged in (via API key).` on the first line even when the server rejects the stored key. Its `User / team info:` section prints `Failed to fetch from server: Authentication required: invalid api key` on a rejected key and `Failed to fetch from server:` or `Unavailable:` when the server check cannot complete.
- `devin auth login` without `--force-manual-token-flow` blocks on a 3-way `ratatui` mode selector over pipes without printing a URL, and browser login invokes `/usr/bin/open` directly on macOS through `open-5.3.3` without consulting `BROWSER` or `PATH`.
- `devin auth login --force-manual-token-flow` prints a PKCE URL carrying `cli_pkce_marker=1` without opening a browser, requires a TTY for `crossterm` cursor-position queries and masked `Code:` input, and exits `0` with `You are already logged in. Use 'devin auth logout' first to re-authenticate.` whenever `credentials.toml` already exists on disk.
- ACP `authenticate` with `{ methodId: "devin-browser" }` opens a loopback callback, invokes `/usr/bin/open` directly without emitting a sign-in URL over ACP, and fails with JSON-RPC `-32603` and `Could not open browser for authentication` when the environment blocks `/usr/bin/open`.
- `devin auth logout` deletes local `$XDG_DATA_HOME/devin/credentials.toml` and plugin caches with exit `0` and performs no remote revocation.
- `session/load` on an existing session emits `session_info_update`, `available_commands_update`, and message-cluster replay `session/update` notifications before returning its RPC result.
- `session/list` records each session's original `cwd`, and `resume` keeps that saved `cwd`.
- `devin update` prompts for confirmation without a `--yes` flag.
- `devin models list` prints variant IDs that ACP `session/set_config_option` rejects with JSON-RPC `-32602` and `Invalid params`.
- `devin doctor --json` checks subagent profiles and OpenTelemetry settings without account quota windows.
- Devin writes no HTTP or stdio MCP environment variables or credentials to SQLite under `$XDG_DATA_HOME/devin`.
- Devin CLI offers no custom OpenAI or Anthropic base URL flag or config key, so OAR wires no `aimock` sea-trial backend.

## Reproduce

```sh
pnpm exec tsx experiments/devin-acp/probe.ts
```

Set `OAR_DEVIN_BIN=/path/to/devin` when `devin` is neither on `PATH` nor at `~/.local/bin/devin`.
