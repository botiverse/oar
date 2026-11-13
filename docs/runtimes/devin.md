# Devin

The [isolated probe](../../experiments/devin-acp/README.md) ran against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-13 in a temporary `HOME` with no credentials or model calls. Versions on this page are evidence baselines rather than a support range. Devin CLI offers no custom OpenAI or Anthropic base URL setting, so OAR wires no `aimock` sea-trial backend, and live authenticated inference remains unverified.

## Native concepts and calling interfaces

`devin acp` serves persistent JSON-RPC over stdio. On `3000.12.57`, `initialize` reports `protocolVersion: 1`, `agentInfo` with `name: "affogato"`, `title: "Devin Agent"`, and `version: "0.0.0-dev"`, `loadSession: true`, `promptCapabilities` for `image` and `embeddedContext` with `audio: false`, `mcpCapabilities` for `http` and `sse`, `sessionCapabilities` for `list`, `delete`, `additionalDirectories`, and `close`, `_meta["cognition.ai/midTurnPrompts"]: true`, and `authMethods` containing `devin-browser`.

CLI flags `--permission-mode` and `--respect-workspace-trust` gate the CLI REPL and `-p` print runner rather than `devin acp`. Bare `devin acp` opens in untrusted directories without a trust prompt, starts every new session in `accept-edits` mode regardless of `--permission-mode`, lists `accept-edits`, `smart`, `ask`, `plan`, and `bypass` in both `modes` and `configOptions`, and switches to `bypass` through `session/set_mode`.

`session/load` emits `session_info_update`, `available_commands_update`, and message-cluster replay `session/update` notifications before returning its RPC result. Calling `session/load` on a missing session ID fails with JSON-RPC `-32016`, `Session not found`, and `data["cognition.ai/errorKind"] === "session_not_found"`. `session/delete` removes a session from both in-memory `session/list` and `$XDG_DATA_HOME/devin/cli/sessions.db`, whereas `session/close` unloads an unprompted session from memory while leaving persisted rows in `sessions.db`.

`session/set_model` returns JSON-RPC `-32601` and `Method not found`. `devin acp` switches model and reasoning effort synchronously through `session/set_config_option`. `devin models list` prints variant IDs that ACP `session/set_config_option` rejects with `-32602` and `Invalid params`, so OAR reads the model catalog from ACP `session/new` `configOptions` instead.

`WINDSURF_API_KEY` is the sole environment credential that `devin` reads. `DEVIN_API_KEY` does not appear in the binary, and `devin` ignores it.

## High-level mapping to OAR

`devinRuntime` belongs to `defaultRuntimes`, and `@botiverse/oar/runtimes/devin` exports it with `execution: "process"` for isolated placement. The runtime entry loads [`session.ts`](../../packages/oar/src/runtimes/devin/session.ts) and [`list-models.ts`](../../packages/oar/src/runtimes/devin/list-models.ts) on first call so importing `@botiverse/oar/runtimes/devin` does not load `@agentclientprotocol/sdk`.

OAR implements `installation`, `install`, `installPlan`, `checkUpdate`, `authStatus`, `listModels`, and `session`. Independent inventory queries return `unsupported`, and `login`, `logout`, `upgrade`, `accountUsage`, `redeemLimitReset`, and provider-auth facades stay absent after checking the CLI and ACP commands below.

| Native concept | OAR mapping |
| --- | --- |
| Executable | One `devin acp` process per Session, launched with `["acp"]` in `cwd` with the env overlay. |
| Conversation | `Session.id` equals the native ACP `sessionId`. `resume` confirms the saved directory through `session/list` and opens the conversation with `session/load`, recording `session_info_update`, `available_commands_update`, and message-cluster replay `session/update` notifications on the opened session stream. |
| Prompt and queue | `prompt()` sends `session/prompt`. `queue()` holds inputs in host memory with `durable: false` and supports `withdraw()` before dispatch. `Session.steer` is absent. |
| Cancel and dispose | `abort()` sends `session/cancel` with a 10-second process-kill fallback. `dispose()` closes the session when `initialize` advertises `close` and terminates the owned process tree and hosted terminals. |
| Model and effort | `modelViaConfigOption: true` sends synchronous `session/set_config_option` calls for `model` and `thought_level` without waiting for async config notifications. |
| Auth and turn failures | `openFailure` maps `-32603` authentication errors at open to `RuntimeFailureError` with `failure: "auth"`. `failureOutcome` maps `-32000` and `-32603` authentication errors on turns to `failure: "auth"`, while rate-limit, quota, and billing turn payloads under `data["cognition.ai/errorKind"]` remain unverified. |
| Child attribution | `opaque`. OAR infers no child session identity or graph edges. |
| Compaction | `Session.compact` is absent and `manualCompaction` is `unsupported`. Native `available_commands_update` lists `/compact` without a verified completion contract. |

The implementation spans [index.ts](../../packages/oar/src/runtimes/devin/index.ts), [session.ts](../../packages/oar/src/runtimes/devin/session.ts), [list-models.ts](../../packages/oar/src/runtimes/devin/list-models.ts), [options.ts](../../packages/oar/src/runtimes/devin/options.ts), [installation.ts](../../packages/oar/src/runtimes/devin/installation.ts), [install.ts](../../packages/oar/src/runtimes/devin/install.ts), [update.ts](../../packages/oar/src/runtimes/devin/update.ts), and [auth.ts](../../packages/oar/src/runtimes/devin/auth.ts).

## Capability details

### Session creation and resume

OAR launches `devin acp` with `["acp"]` from `devinAcpArgs`. After `session/new` or `session/load`, `configureSession` sends `session/set_mode` with `modeId: "bypass"` when `supportsDevinBypass` finds `"bypass"` in `modes.availableModes` or `configOptions` for `mode`. Opening requests time out after 30 seconds.

`devinAcpProfile` maps `-32603` authentication errors matching `Authentication required`, `invalid api key`, or `not logged in` at session open to `RuntimeFailureError` with `failure: "auth"` through `openFailure`.

Devin resumes a session in its saved `cwd` and ignores a different `cwd` passed on resume, so `devinAcpProfile` sets `resumeKeepsSessionCwd: true`. Before sending `session/load`, OAR calls `session/list` and requires a matching entry with the same directory, as documented in [resume-cwd](resume-cwd.md). A different directory, missing list entry, or unconfirmed `cwd` rejects with `UnsupportedOptionError` on `cwd`.

`devinAcpProfile` sets `isResumeNotFound` for JSON-RPC `-32016` with `data["cognition.ai/errorKind"] === "session_not_found"`. That check maps to `SessionNotFoundError` if a session listed in `session/list` disappears before `session/load` completes, while unlisted session IDs still hit the prior `session/list` `cwd` refusal.

When `session/load` runs, `devin acp` emits `session_info_update`, `available_commands_update`, and message-cluster replay `session/update` notifications before returning its RPC result, which OAR records on the opened session stream.

### Prompt, queueing, and abort

`prompt()` resolves once OAR sends the RPC and rejects as `busy` while an active turn or queued input holds the slot. Image support follows `initialize.agentCapabilities.promptCapabilities.image`, which reports `true` on `3000.12.57`.

`initialize` advertises `_meta["cognition.ai/midTurnPrompts"]: true`, and OAR has verified neither a second `session/prompt` mid-turn nor `cognition.ai/midTurnPrompts` without a live authenticated turn, so `Session.steer` is absent.

`queue()` buffers inputs in host memory with `durable: false`, and `withdraw()` removes queued entries before dispatch. `abort()` sends `session/cancel` and kills the process tree after 10 seconds if the turn does not settle.

Logged-out `session/prompt` returns JSON-RPC `-32000`. `devinAcpProfile` maps `-32000` and `-32603` authentication errors on turns to `failure: "auth"` through `failureOutcome`. Devin turn errors carry `data["cognition.ai/errorKind"]`, and rate-limit, quota, and billing turn payloads remain unverified until a live account run captures them.

### Models and effort

`devinListModels` bounds `initialize`, `session/new`, cleanup, and fallback `authStatus` under one shared `timeoutMs` deadline that defaults to 30 seconds. After reading `session/new` without sending a prompt, `devinListModels` calls `session/delete` when `initialize` advertises `sessionCapabilities.delete` and falls back to `session/close` otherwise, removing the temporary session from `session/list` and `sessions.db`.

`projectDevinModels` reads `model` and `thought_level` from `configOptions`:

- When `projectDevinModels` returns an empty model list, `devinListModels` checks `readDevinAuthStatus` under the remaining deadline. `logged_out` maps to `unauthenticated`, `logged_in` returns an empty `ok` list, `unknown` with configured credentials returns `unsupported`, and unreadable status rejects.
- When the environment sets an invalid `WINDSURF_API_KEY`, `session/new` fails with JSON-RPC `-32603` and `Authentication required: invalid api key`. `devinListModels` maps `-32000` and authentication error messages to `{ kind: "unauthenticated" }`.

When opening a session with `model` or `effort`, OAR applies each value sequentially through `session/set_config_option` with `modelViaConfigOption: true` and leaves `confirmConfigOptionUpdates` unset.

### Session MCP servers

ACP `session/new` and `session/load` accept stdio and HTTP `mcpServers` entries, including non-empty `env` and `headers`, so `serveMcpTools` entries attach without refusal. Isolated `3000.12.57` checks confirmed that Devin writes no HTTP or stdio MCP `env` values or credentials to its SQLite store under `$XDG_DATA_HOME/devin`. OAR leaves `mcpToolsListChanged` undeclared.

### Refused session options and launch arguments

`devinRefusedSessionOptions` refuses 10 `SessionOptions` keys before spawning a process:

`additionalDirectories`, `appendSystemPrompt`, `disallowedTools`, `endTurnProcessesOnAbort`, `goals`, `name`, `outputSchema`, `serviceTier`, `systemPrompt`, and `userConfiguration`.

`initialize` advertises `sessionCapabilities.additionalDirectories`, and `devinRefusedSessionOptions` refuses `additionalDirectories` because OAR has not verified that primary `cwd` and tool scoping honor it.

OAR appends `launchArgs` after `acp` without validation and never persists them. Callers must pass them again on resume.

### Process ownership, installation, and update checks

**Discovery.** `devinInstallation` checks `OAR_DEVIN_BIN`, searches `PATH` for `devin`, and falls back to `~/.local/bin/devin` on POSIX. On Windows, `devinInstallation` checks `%LOCALAPPDATA%\devin\cli\bin\devin.exe`, falling back to `%USERPROFILE%\AppData\Local\devin\cli\bin\devin.exe` only when `LOCALAPPDATA` is unset. Readiness runs `devin acp --help`, and `readDevinVersion` parses `devin <semver>` with an optional commit hash.

**Installation.** `devinInstallPlan` and `devinInstall` run the official shell installer from the [Devin CLI documentation](https://docs.devin.ai/cli) on macOS and Linux:

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

`WINDSURF_API_KEY` is the sole environment credential that `devin` reads. `DEVIN_API_KEY` does not appear in the binary, and `devin` ignores it.

`devinAuthStatus` runs `devin auth status` with a 30-second deadline, accepts `timeoutMs`, and omits `localOnly`:

- `devin auth status` exits `0` across logged-out, corrupt, rejected, and logged-in states and ignores `WINDSURF_API_KEY`.
- When the effective environment sets a non-empty `WINDSURF_API_KEY`, OAR returns `{ kind: "unknown", source: "devin auth status", configured: ["environment: WINDSURF_API_KEY"] }` without validating or echoing the key.
- Otherwise, `parseDevinAuthStatus` classifies observed `3000.12.57` outputs while stripping `Credentials path:` and `File:` lines:
  - `Not logged in.` returns `logged_out`.
  - `Failed to load credentials:` returns `unknown`.
  - `Logged in (via Devin).` and `Logged in (via API key).` check `User / team info:` so server-rejected keys matching `Failed to fetch from server: ... Authentication required` or `invalid api key` return `logged_out`, unreachable server checks matching `Failed to fetch from server:` or `Unavailable:` return `unknown` with `configured: ["stored credentials"]`, and clean responses return `logged_in` with `method` and optional `credential: "api_key"`. Authenticated `User / team info:` account fields remain unverified pending live account capture.

Checks on `devin 3000.12.57` account for the absent members:

- **Login and logout.** OAR checked every CLI and ACP sign-in route on `3000.12.57`:
  - `devin auth login` without `--force-manual-token-flow` blocks on a 3-way `ratatui` mode selector over pipes with no URL printed, and browser login invokes `/usr/bin/open` directly on macOS through `open-5.3.3` without consulting `BROWSER` or `PATH`.
  - `devin auth login --force-manual-token-flow` prints a PKCE URL with `cli_pkce_marker=1` without opening a browser, then requires a TTY for `crossterm` cursor-position queries and masked `Code:` input. Two obstacles block `Runtime.login` prior to live Linux verification. When `$XDG_DATA_HOME/devin/credentials.toml` already exists on disk, even with an expired or invalid key, `devin auth login --force-manual-token-flow` prints `You are already logged in. Use 'devin auth logout' first to re-authenticate.` and exits `0`, which conflicts with OAR's rule never to clear stored credentials before new ones exist. In addition, `openScriptTerminal` runs on Linux only because macOS BSD `script` fails on socketpair stdin in `#752` and Windows has no `script` utility, and PKCE code exchange requires a live account.
  - ACP `authenticate` with `devin-browser` opens a loopback callback and invokes `/usr/bin/open` directly, never emits the sign-in URL over ACP, and fails with JSON-RPC `-32603` and `Could not open browser for authentication` when browser launch is unavailable.
  - ACP `/login` accepts an API key only inside `session/prompt`.
  - `devin auth logout` removes local `$XDG_DATA_HOME/devin/credentials.toml` and plugin caches with exit `0` and no remote revocation. OAR omits `logout` alongside `login` per [the login contract](../spec/login.md#logout).
- **Providers.** `devin --help`, `devin doctor --json`, `$XDG_CONFIG_HOME/devin/config.json`, and ACP `available_commands_update` offer no third-party provider configuration or per-provider credential store. ACP `/billing` only toggles whether a linked provider plan pays for its models, so OAR exports no provider-auth facade.
- **Account usage and limit resets.** `devin --help`, `devin auth --help`, `devin doctor --json`, and ACP `available_commands_update` offer no account quota window or limit-reset call. ACP `/context` and `/session-stats` report session-level state only, so `accountUsage` and `redeemLimitReset` stay absent.
- **Independent inventories.** `skills`, `commands`, `mcpServers`, and `tools` return `unsupported` with `transport_unavailable` from `defineRuntime`. `devin skills list --json`, `devin mcp list --json`, `devin plugins list`, and session-scoped `available_commands_update` exist natively and remain unmapped.

## Orientation query costs and reader environment

`listModels` runs `devin acp` in `listingCwd(options)`, which uses `options.cwd` or `process.cwd()`. That call initializes `$XDG_DATA_HOME/devin/cli/sessions.db`, `$XDG_CONFIG_HOME/devin/config.json`, and a lock file under `session_locks/`, and scans `cwd` rules and skills before `session/delete` removes the session entry. `OAR_DEVIN_BIN`, `HOME`, `XDG_*`, and `WINDSURF_API_KEY` in `env` overlays apply to installation checks, auth status, model listing, and sessions without mutating `process.env`.

## Verification and open gaps

- [`experiments/devin-acp/probe.ts`](../../experiments/devin-acp/probe.ts) runs an isolated zero-token CLI and ACP handshake probe verified against `devin 3000.12.57` on macOS arm64 on 2026-11-13.
- Unit and fake-ACP suites cover version and path discovery, installer preflight, `distribution` manifest resolution, `authStatus` parsing across missing, corrupt, server-rejected, and unreachable credential states, `WINDSURF_API_KEY` handling, `listModels` shared deadline, `session/delete` cleanup, empty-catalog auth disambiguation, `-32603` open and turn auth mapping, `bypass` mode switching, synchronous `model` and `thought_level` config options, `resumeKeepsSessionCwd` refusal, `isResumeNotFound` `-32016` mapping, and refused session options.
- Live authenticated inference, `session/prompt` rate-limit, quota, and billing payloads, mid-turn prompt behavior, authenticated `User / team info:` fields, tool-call detail projection, child attribution, and Linux and Windows installer runs remain unverified.
