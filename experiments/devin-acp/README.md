# Devin CLI ACP probe

[`probe.ts`](probe.ts) runs an isolated zero-token check against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-13. The script creates a temporary `HOME` with `mkdtempSync`, removes it on exit, and touches no user configuration, stored credentials, or model quota.

## Observed results

| Check | Measured result on `devin 3000.12.57` |
| --- | --- |
| `devin --version` | Exits `0` and prints `devin 3000.12.57 (96542e930752)`. |
| `devin auth status` in clean `HOME` | Exits `0` and prints `Not logged in.`, `Credentials path: ...`, and `Run \`devin auth login\` to authenticate.`. |
| `devin auth status` with synthetic `WINDSURF_API_KEY` | Exits `0`, prints the same `Not logged in.` output, and ignores `WINDSURF_API_KEY`. |
| ACP `initialize` on `devin --permission-mode dangerous --respect-workspace-trust false acp` | Reports `protocolVersion: 1`, `agentInfo.name: "affogato"`, `loadSession: true`, `promptCapabilities` for `image` and `embeddedContext` with `audio: false`, `mcpCapabilities` for `http` and `sse`, `sessionCapabilities` for `list`, `delete`, `additionalDirectories`, and `close`, and `authMethods` for `devin-browser`. |
| ACP `session/new` while logged out | Opens with `modes.currentModeId: "accept-edits"` and `availableModes` containing `bypass`. `configOptions` lists `mode` with 5 options and `model` with `currentValue: "swe-1-6-fast"` and `options: []`. `available_commands_update` lists 22 slash commands without an account quota or limit-reset query. |
| ACP `session/set_mode` to `"bypass"` | Returns `{}`. |
| ACP `session/set_model` | Fails with JSON-RPC `-32601` and `Method not found`. Model switching uses `session/set_config_option`. |
| ACP `session/load` on missing session ID | Fails with JSON-RPC `-32016`, `Session not found`, and `data["cognition.ai/errorKind"] = "session_not_found"`. |

Additional isolated checks outside `probe.ts` established these vendor behaviors:

- `session/new` with a synthetic invalid `WINDSURF_API_KEY` fails with JSON-RPC `-32603` and `Failed to load team settings: Failed to fetch team settings: Authentication required: invalid api key`.
- `devin auth login`, with or without `--force-manual-token-flow`, opens `/dev/tty` in a `ratatui` TUI.
- `devin update` prompts for confirmation without a `--yes` flag.
- `devin models list` prints variant IDs that ACP `session/set_config_option` rejects with JSON-RPC `-32602` and `Invalid params`.
- `session/list` records each session's original `cwd`, and `resume` keeps that saved `cwd`.
- `devin doctor --json` checks subagent profiles and OpenTelemetry settings without account quota windows.
- Devin does not write HTTP or stdio MCP environment variables or credentials to SQLite under `~/.local/share/devin`.
- Devin CLI offers no custom OpenAI or Anthropic base URL flag or config key, so OAR wires no `aimock` sea-trial backend.

## Reproduce

```sh
pnpm exec tsx experiments/devin-acp/probe.ts
```

Set `OAR_DEVIN_BIN=/path/to/devin` when `devin` is neither on `PATH` nor at `~/.local/bin/devin`.
