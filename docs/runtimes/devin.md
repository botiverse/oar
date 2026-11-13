# Devin

OAR connects to the Devin CLI's native ACP server through `devin acp` over stdio JSON-RPC. The [isolated probe](../../experiments/devin-acp/README.md) ran against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-13 in a temporary `HOME` with no credentials or model calls. Devin CLI offers no custom OpenAI or Anthropic base URL setting, so OAR wires no `aimock` sea-trial backend. Authenticated inference, streaming tool outcomes, and child attribution remain unverified against a live account.

OAR implements `installation`, `install`, `installPlan`, `checkUpdate`, `authStatus`, `listModels`, and `session`. Independent inventory queries return `unsupported`, and `login`, `logout`, `upgrade`, `accountUsage`, `redeemLimitReset`, and provider-auth facades stay absent after checking the CLI and ACP commands below.

## Native concepts and calling interfaces

`devin acp` serves persistent JSON-RPC over stdio. On `3000.12.57`, `initialize` reports `protocolVersion: 1`, `agentInfo` with `name: "affogato"` and `title: "Devin Agent"`, `loadSession: true`, `promptCapabilities` for `image` and `embeddedContext` with `audio: false`, `mcpCapabilities` for `http` and `sse`, `sessionCapabilities` for `list`, `delete`, `additionalDirectories`, and `close`, and `authMethods` containing `devin-browser`.

A new session opens in `accept-edits` mode and lists `accept-edits`, `smart`, `ask`, `plan`, and `bypass` in both `modes` and `configOptions`. OAR starts `devin --permission-mode dangerous --respect-workspace-trust false acp` and switches the opened session to `bypass` through `session/set_mode` when the session advertises `bypass`.

`session/set_model` returns JSON-RPC `-32601 Method not found`. `devin acp` switches model and reasoning effort synchronously through `session/set_config_option`. `devin models list` prints variant IDs that ACP `session/set_config_option` rejects with `-32602 Invalid params`, so OAR reads the model catalog from ACP `session/new` `configOptions` instead.

## High-level mapping to OAR

`devinRuntime` belongs to `defaultRuntimes` and `@botiverse/oar/runtimes/devin` exports it with `execution: "process"` for isolated placement. The runtime entry loads [`session.ts`](../../packages/oar/src/runtimes/devin/session.ts) and [`list-models.ts`](../../packages/oar/src/runtimes/devin/list-models.ts) on first call so importing `@botiverse/oar/runtimes/devin` does not load `@agentclientprotocol/sdk`.

| Native concept | OAR mapping |
| --- | --- |
| Executable | One `devin --permission-mode dangerous --respect-workspace-trust false acp` process per Session, launched in `cwd` with the env overlay. |
| Conversation | `Session.id` equals the native ACP `sessionId`. `resume` confirms the saved directory through `session/list` and opens the conversation with `session/load` without history replay. |
| Prompt and queue | `prompt()` sends `session/prompt`. `queue()` holds inputs in host memory with `durable: false` and supports `withdraw()` before dispatch. `Session.steer` is absent. |
| Cancel and dispose | `abort()` sends `session/cancel` with a 10-second process-kill fallback. `dispose()` closes the session when supported and terminates the owned process tree and hosted terminals. |
| Model and effort | `modelViaConfigOption: true` sends synchronous `session/set_config_option` calls for `model` and `thought_level` without waiting for async config notifications. |
| Turn limits and failures | Shared `acpFailureOutcome` maps `-32000` to `auth` and passes other prompt errors through `classifyFailure` for `rate_limited`, `quota`, and `billing`. |
| Child attribution | `opaque`. OAR infers no child session identity or graph edges. |
| Compaction | `Session.compact` is absent and `manualCompaction` is `unsupported`. Native `available_commands_update` lists `/compact` without a verified completion contract. |

The implementation spans [index.ts](../../packages/oar/src/runtimes/devin/index.ts), [session.ts](../../packages/oar/src/runtimes/devin/session.ts), [list-models.ts](../../packages/oar/src/runtimes/devin/list-models.ts), [options.ts](../../packages/oar/src/runtimes/devin/options.ts), [installation.ts](../../packages/oar/src/runtimes/devin/installation.ts), [install.ts](../../packages/oar/src/runtimes/devin/install.ts), [update.ts](../../packages/oar/src/runtimes/devin/update.ts), and [auth.ts](../../packages/oar/src/runtimes/devin/auth.ts).

## Capability details

### Session creation and resume

OAR launches ACP with `--permission-mode dangerous --respect-workspace-trust false acp` from `devinAcpArgs`. After `session/new` or `session/load`, `configureSession` sends `session/set_mode` with `modeId: "bypass"` when `supportsDevinBypass` finds `"bypass"` in `modes.availableModes` or `configOptions` for `mode`. Opening requests time out after 30 seconds.

Devin resumes a session in its saved `cwd` and ignores a different `cwd` passed on resume, so the profile sets `resumeKeepsSessionCwd: true`. Before sending `session/load`, OAR calls `session/list` and requires a matching entry with the same directory, as documented in [resume-cwd](resume-cwd.md). A different directory, missing list entry, or unconfirmed `cwd` rejects with `UnsupportedOptionError` on `cwd`. Calling `session/load` directly on a missing session ID returns JSON-RPC `-32016` with `Session not found`, and OAR's prior `session/list` check turns unlisted session IDs into the `cwd` refusal rather than `SessionNotFoundError`.

### Prompt, queueing, and abort

`prompt()` resolves once OAR sends the RPC and rejects as `busy` while an active turn or queued input holds the slot. Image support follows `initialize.agentCapabilities.promptCapabilities.image`, which reports `true` on `3000.12.57`. OAR omits `Session.steer`. `queue()` buffers inputs in host memory with `durable: false`, and `withdraw()` removes queued entries before dispatch. `abort()` sends `session/cancel` and kills the process tree after 10 seconds if the turn does not settle.

### Models and effort

`listModels()` starts a temporary ACP process, runs `initialize` and `session/new` without a prompt, closes the session when `sessionCapabilities.close` is `true`, and projects `model` and `thought_level` from `configOptions` through `projectDevinModels`:

- When logged out, `session/new` returns `configOptions` with `currentValue: "swe-1-6-fast"` and an empty `options: []` array on `model`. When `projectDevinModels` produces an empty list, `devinListModels` calls `readDevinAuthStatus` and returns `{ kind: "unauthenticated" }` if the CLI reports `logged_out`.
- When the environment sets an invalid `WINDSURF_API_KEY`, `session/new` fails with JSON-RPC `-32603` and `Authentication required: invalid api key`. `devinListModels` maps `-32000` and authentication error messages to `{ kind: "unauthenticated" }`.

When opening a session with `model` or `effort`, OAR applies each value sequentially through `session/set_config_option` with `modelViaConfigOption: true` and leaves `confirmConfigOptionUpdates` unset.

### Session MCP servers

ACP `session/new` and `session/load` accept stdio and HTTP `mcpServers` entries, including non-empty `env` and `headers`, so `serveMcpTools` entries attach without refusal. Isolated `3000.12.57` checks confirmed that Devin does not write HTTP or stdio MCP `env` values or credentials to its SQLite store under `~/.local/share/devin`. OAR leaves `mcpToolsListChanged` undeclared.

### Refused session options and launch arguments

`devinRefusedSessionOptions` refuses 10 `SessionOptions` keys before spawning a process:

`additionalDirectories`, `appendSystemPrompt`, `disallowedTools`, `endTurnProcessesOnAbort`, `goals`, `name`, `outputSchema`, `serviceTier`, `systemPrompt`, and `userConfiguration`.

OAR appends `launchArgs` after `acp` without validation and never persists them. Callers must pass them again on resume.

### Process ownership, installation, and update checks

**Discovery.** `devinInstallation` checks `OAR_DEVIN_BIN`, searches `PATH` for `devin`, and falls back to `~/.local/bin/devin` on POSIX or `%LOCALAPPDATA%\devin\cli\bin\devin.exe` and `%USERPROFILE%\AppData\Local\devin\cli\bin\devin.exe` on Windows. Readiness runs `devin acp --help`, and `readDevinVersion` parses `devin <semver>` with an optional commit hash.

**Installation.** `devinInstallPlan` and `devinInstall` run the official shell installer from https://docs.devin.ai/cli on macOS and Linux:

```sh
curl -fsSL https://cli.devin.ai/install.sh | bash
```

Preflight checks `curl`, `bash`, and write access to `~/.local/bin`, `$XDG_DATA_HOME/devin` or `~/.local/share/devin`, and `$XDG_DATA_HOME/man/man1` or `~/.local/share/man/man1`. On Windows, `installPlan` returns the documented PowerShell command `irm https://static.devin.ai/cli/setup.ps1 | iex` as an `unsupported_platform` plan without running it.

Two vendor installer behaviors shape preflight and completion:

- The vendor script refuses to overwrite a regular non-symlink file at `~/.local/bin/devin`, so `devinInstallPlan` rejects an existing regular file at the unpinned POSIX install path with `unsupported` and reason `configuration` before downloading.
- In non-interactive runs without a TTY, the trailing `devin setup` wizard exits `1` after linking `~/.local/bin/devin`. `planInstaller` verifies installation by re-running `devinInstallation()` afterward rather than checking the script exit code, so OAR recognizes the linked binary when `devin --version` and `devin acp --help` pass.

**Update checks.** `devinCheckUpdate` resolves `realpath(command)`, reads the sibling `../distribution` marker file through `readDevinDistribution`, and fetches the matching manifest:

| `distribution` marker | Manifest URL |
| --- | --- |
| `curl-bash`, `irm-iex` | `https://static.devin.ai/cli/current/manifest.json` |
| `curl-bash-enterprise`, `irm-iex-enterprise` | `https://static.devinenterprise.com/cli/current/manifest-enterprise.json` |
| `curl-bash-windsurfcom`, `irm-iex-windsurfcom` | `https://static.devin.ai/cli/current/manifest-windsurfcom.json` |

Installations from Homebrew `devin-cli`, the Devin Desktop bundle, or portal and federal installers have no supported `distribution` marker and return `{ kind: "unavailable", reason: "unsupported_installation" }`. OAR omits `upgrade` because `devin update` prompts for confirmation without a `--yes` flag.

### Authentication, providers, usage, and inventories

`devinAuthStatus` runs `devin auth status` with a 30-second deadline, accepts `timeoutMs`, and omits `localOnly`:

- `devin auth status` exits `0` in both logged-in and logged-out states and ignores `WINDSURF_API_KEY`.
- When the effective environment sets a non-empty `WINDSURF_API_KEY`, OAR returns `{ kind: "unknown", source: "devin auth status", configured: ["environment: WINDSURF_API_KEY"] }` without validating or echoing the key.
- Otherwise, `parseDevinAuthStatus` maps `Not logged in.` to `logged_out` and `Logged in...` to `logged_in`, and extracts optional `email`, `method` from `via <method>`, and `credential: "api_key"` from `with provided API key` while stripping `Credentials path:` lines and secrets.

Checks on `devin 3000.12.57` account for the absent members:

- **Login and logout.** `devin auth login` opens `/dev/tty` in a `ratatui` TUI even with `--force-manual-token-flow`. ACP `authenticate` advertises `devin-browser` without a non-browser URL relay or code prompt, and ACP `/login` takes an API key inside `session/prompt`. OAR omits `login`, and per [the login contract](../spec/login.md#logout) omits `logout` as well even though `devin auth logout` exists on the CLI.
- **Providers.** `devin --help`, `devin doctor --json`, `~/.config/devin/config.json`, and ACP `available_commands_update` offer no third-party provider configuration or per-provider credential store. ACP `/billing` only toggles whether a linked provider plan pays for its models, so OAR exports no provider-auth facade.
- **Account usage and limit resets.** `devin --help`, `devin auth --help`, `devin doctor --json`, and ACP `available_commands_update` offer no account quota window or limit-reset call. ACP `/context` and `/session-stats` report session-level state only, so `accountUsage` and `redeemLimitReset` stay absent. On turns, `openAcpSession` routes non-`-32000` JSON-RPC prompt errors through shared `classifyFailure`, which maps HTTP `429` and rate-limit codes to `rate_limited`, quota codes to `quota`, and `402` or credit-exhaustion errors to `billing`.
- **Independent inventories.** `skills`, `commands`, `mcpServers`, and `tools` return `unsupported` with `transport_unavailable` from `defineRuntime`. `devin skills list --json`, `devin mcp list --json`, `devin plugins list`, and session-scoped `available_commands_update` exist natively and remain unmapped.

## Orientation query costs and reader environment

`listModels` opens a short-lived ACP process and calls `session/new` without sending a prompt. `OAR_DEVIN_BIN`, `HOME`, `XDG_*`, and `WINDSURF_API_KEY` in `env` overlays apply to installation checks, auth status, model listing, and sessions without mutating `process.env`.

## Verification and open gaps

- [`experiments/devin-acp/probe.ts`](../../experiments/devin-acp/probe.ts) runs an isolated zero-token CLI and ACP handshake probe verified against `devin 3000.12.57` on macOS arm64 on 2026-11-13.
- Unit and fake-ACP suites cover version and path discovery, installer preflight, `distribution` manifest resolution, `authStatus` parsing, `WINDSURF_API_KEY` handling, `listModels` auth fallback and `-32603` mapping, `bypass` mode switching, synchronous `model` and `thought_level` config options, `resumeKeepsSessionCwd` refusal, and refused session options.
- Live authenticated inference, `session/prompt` turn and limit payloads, tool-call detail projection, child attribution, and Linux and Windows installer runs remain unverified.
