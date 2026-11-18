# Devin

The [isolated probes](../../experiments/devin-acp/README.md) ran against `devin 3000.12.57`, commit `96542e930752`, on macOS arm64 on 2026-11-13 and 2026-11-14 in temporary `HOME` directories with synthetic local servers and no real credentials or model calls. Versions on this page are evidence baselines rather than a support range. `devin acp` speaks ConnectRPC protobuf on `/exa.*` routes rather than OpenAI or Anthropic HTTP, so OAR wires no `aimock` sea-trial backend, and live authenticated inference remains unverified.

## Native concepts and calling interfaces

`devin acp` serves persistent JSON-RPC over stdio. On `3000.12.57`, `initialize` reports `protocolVersion: 1`, `agentInfo` with `name: "affogato"`, `title: "Devin Agent"`, and `version: "0.0.0-dev"`, `loadSession: true`, `promptCapabilities` for `image` and `embeddedContext` with `audio: false`, `mcpCapabilities` for `http` and `sse`, `sessionCapabilities` for `list`, `delete`, `additionalDirectories`, and `close`, `_meta["cognition.ai/midTurnPrompts"]: true`, and `authMethods` containing `devin-browser`.

CLI flags `--permission-mode` and `--respect-workspace-trust` gate the CLI REPL and `-p` print runner rather than `devin acp`. Bare `devin acp` opens in untrusted directories without a trust prompt, starts every new session in `accept-edits` mode regardless of `--permission-mode`, lists `accept-edits`, `smart`, `ask`, `plan`, and `bypass` in both `modes` and `configOptions`, and switches to `bypass` through `session/set_mode`.

`session/load` emits `session_info_update`, `available_commands_update`, and message-cluster replay `session/update` notifications before returning its RPC result. Calling `session/load` on a missing session ID fails with JSON-RPC `-32016`, `Session not found`, and `data["cognition.ai/errorKind"] === "session_not_found"`. `session/delete` removes a session from both in-memory `session/list` and `$XDG_DATA_HOME/devin/cli/sessions.db`, whereas `session/close` unloads an unprompted session from memory while leaving persisted rows in `sessions.db`.

`session/set_model` returns JSON-RPC `-32601` and `Method not found`. `devin acp` switches model and reasoning effort synchronously through `session/set_config_option`. `devin models list` prints variant IDs that ACP `session/set_config_option` rejects with `-32602` and `Invalid params`, so OAR reads the model catalog from ACP `session/new` `configOptions` instead.

## High-level mapping to OAR

`devinRuntime` belongs to `defaultRuntimes`, and `@botiverse/oar/runtimes/devin` exports it with `execution: "process"` for isolated placement. The runtime entry loads [`session.ts`](../../packages/oar/src/runtimes/devin/session.ts) and [`list-models.ts`](../../packages/oar/src/runtimes/devin/list-models.ts) on first call so importing `@botiverse/oar/runtimes/devin` does not load `@agentclientprotocol/sdk`.

OAR implements `installation`, `install`, `installPlan`, `checkUpdate`, `authStatus`, `listModels`, `skills`, and `session`. The other independent inventory queries return `unsupported`, and `login`, `logout`, `upgrade`, `accountUsage`, `redeemLimitReset`, and provider-auth facades stay absent after checking the CLI and ACP commands below.

| Native concept | OAR mapping |
| --- | --- |
| Executable | One `devin acp` process per Session, launched with `["acp"]` in `cwd` with the env overlay. |
| Conversation | `Session.id` equals the native ACP `sessionId`. `resume` confirms the saved directory through `session/list` and opens the conversation with `session/load`, recording its replay notifications on the opened session stream. |
| Prompt and queue | `prompt()` sends `session/prompt`. `queue()` holds inputs in host memory with `durable: false` and supports `withdraw()` before dispatch. `Session.steer` is absent. |
| Cancel and dispose | `abort()` sends `session/cancel` with a 10-second process-kill fallback. `dispose()` closes the session when `initialize` advertises `close` and terminates the owned process tree and hosted terminals. |
| Model and effort | `modelViaConfigOption: true` sends synchronous `session/set_config_option` calls for `model` and `thought_level` without waiting for async config notifications. |
| Auth and turn failures | Authentication errors at open are `RuntimeFailureError` with `failure: "auth"`, and on turns `failure: "auth"` ([details](#prompt-queueing-and-abort)); rate-limit, quota, and billing turn payloads remain unverified. |
| Child attribution | `opaque`. OAR infers no child session identity or graph edges. |
| Compaction | `Session.compact` is absent and `manualCompaction` is `unsupported`. Native `available_commands_update` lists `/compact` without a verified completion contract. |

The implementation spans [index.ts](../../packages/oar/src/runtimes/devin/index.ts), [session.ts](../../packages/oar/src/runtimes/devin/session.ts), [list-models.ts](../../packages/oar/src/runtimes/devin/list-models.ts), [options.ts](../../packages/oar/src/runtimes/devin/options.ts), [installation.ts](../../packages/oar/src/runtimes/devin/installation.ts), [install.ts](../../packages/oar/src/runtimes/devin/install.ts), [update.ts](../../packages/oar/src/runtimes/devin/update.ts), and [auth.ts](../../packages/oar/src/runtimes/devin/auth.ts).

## Capability details

### Session creation and resume

OAR launches `devin acp` with `["acp"]` from `devinAcpArgs`. After `session/new` or `session/load`, `configureSession` sends `session/set_mode` with `modeId: "bypass"` when `supportsDevinBypass` finds `"bypass"` in `modes.availableModes` or `configOptions` for `mode`. Initialize has a separate 60-second deadline; other bounded opening requests retain 30 seconds ([shared deadlines](../spec/runtime-matrix.md#acp-opening-deadlines)).

`devinAcpProfile` maps `-32603` authentication errors matching `Authentication required`, `invalid api key`, or `not logged in` at session open to `RuntimeFailureError` with `failure: "auth"` through `openFailure`.

Devin resumes a session in its saved `cwd` and ignores a different `cwd` passed on resume, so `devinAcpProfile` sets `resumeKeepsSessionCwd: true`. Before sending `session/load`, OAR calls `session/list` and requires a matching entry with the same directory, as documented in [resume-cwd](resume-cwd.md). A different directory, missing list entry, or unconfirmed `cwd` rejects with `ResumeCwdError` (an `UnsupportedOptionError` on `cwd`) carrying a typed reason. `not_listed` identifies an omitted id, not proof that history is gone.

`devinAcpProfile` sets `isResumeNotFound` for JSON-RPC `-32016` with `data["cognition.ai/errorKind"] === "session_not_found"`. That check maps to `SessionNotFoundError` if a session listed in `session/list` disappears before `session/load` completes, while unlisted session IDs still hit the prior `session/list` `cwd` refusal.

OAR records the notifications `session/load` emits before its RPC result on the opened session stream.

### Prompt, queueing, and abort

`prompt()` resolves once OAR sends the RPC and rejects as `busy` while an active turn or queued input holds the slot. Image support follows `initialize.agentCapabilities.promptCapabilities.image`, which reports `true` on `3000.12.57`.

`initialize` advertises `_meta["cognition.ai/midTurnPrompts"]: true`, and OAR has verified neither a second `session/prompt` mid-turn nor `cognition.ai/midTurnPrompts` without a live authenticated turn, so `Session.steer` is absent.

`queue()` buffers inputs in host memory with `durable: false`, and `withdraw()` removes queued entries before dispatch. `abort()` sends `session/cancel` and kills the process tree after 10 seconds if the turn does not settle.

Logged-out `session/prompt` returns JSON-RPC `-32000`. `devinAcpProfile` maps `-32000` and `-32603` authentication errors on turns to `failure: "auth"` through `failureOutcome`. Devin turn errors carry `data["cognition.ai/errorKind"]`, and rate-limit, quota, and billing turn payloads remain unverified until a live account run captures them.

### Models and effort

`devinRuntime.listModels` bounds `initialize`, `session/new`, cleanup, and fallback `authStatus` under one shared `timeoutMs` deadline that defaults to 30 seconds. After reading `session/new` without sending a prompt, `devinRuntime.listModels` calls `session/delete` when `initialize` advertises `sessionCapabilities.delete` and falls back to `session/close` otherwise, removing the temporary session from `session/list` and `sessions.db`.

The internal `projectDevinModels` mapper reads `model` and `thought_level` from `configOptions`:

- When `session/new` carries no `model` config option, `devinRuntime.listModels` returns `unsupported`.
- When `projectDevinModels` returns an empty model list, `devinRuntime.listModels` checks the internal `readDevinAuthStatus` helper under the remaining deadline. `logged_out` maps to `unauthenticated`, `logged_in` returns an empty `ok` list, `unknown` with configured credentials returns `unsupported`, and unreadable status rejects.
- When the environment sets an invalid `WINDSURF_API_KEY`, `session/new` fails with JSON-RPC `-32603` and `Authentication required: invalid api key`. `devinRuntime.listModels` maps `-32000` and authentication error messages to `{ kind: "unauthenticated" }`.

When opening a session with `model` or `effort`, OAR applies each value sequentially through `session/set_config_option` with `modelViaConfigOption: true` and leaves `confirmConfigOptionUpdates` unset.

### Session MCP servers

ACP `session/new` and `session/load` accept stdio and HTTP `mcpServers` entries, including non-empty `env` and `headers`, so `serveMcpTools` entries attach without refusal. Isolated `3000.12.57` checks confirmed that Devin writes no HTTP or stdio MCP `env` values or credentials to its SQLite store under `$XDG_DATA_HOME/devin`. OAR leaves `mcpToolsListChanged` undeclared.

### Refused session options and launch arguments

`devinRuntime.refusedSessionOptions` refuses 10 `SessionOptions` keys before spawning a process:

`additionalDirectories`, `appendSystemPrompt`, `disallowedTools`, `endTurnProcessesOnAbort`, `goals`, `name`, `outputSchema`, `serviceTier`, `systemPrompt`, and `userConfiguration`.

`initialize` advertises `sessionCapabilities.additionalDirectories`, and `devinRuntime.refusedSessionOptions` refuses `additionalDirectories` because OAR has not verified that primary `cwd` and tool scoping honor it.

OAR appends `launchArgs` after `acp` without validation and never persists them. Callers must pass them again on resume.

### Process ownership, installation, and update checks

**Discovery.** `devinRuntime.installation` checks `OAR_DEVIN_BIN`, searches `PATH` for `devin`, and falls back to `~/.local/bin/devin` on POSIX. On Windows, `devinRuntime.installation` checks `%LOCALAPPDATA%\devin\cli\bin\devin.exe`, falling back to `%USERPROFILE%\AppData\Local\devin\cli\bin\devin.exe` only when `LOCALAPPDATA` is unset. Readiness runs `devin acp --help`, and the internal `readDevinVersion` helper parses `devin <semver>` with an optional commit hash.

**Installation.** `devinRuntime.installPlan` and `devinRuntime.install` run the official shell installer from the [Devin CLI documentation](https://docs.devin.ai/cli) on macOS and Linux:

```sh
curl -fsSL https://cli.devin.ai/install.sh | bash
```

Preflight checks `curl`, `bash`, and write access to `~/.local/bin`, `$XDG_DATA_HOME/devin` or `~/.local/share/devin`, and `$XDG_DATA_HOME/man/man1` or `~/.local/share/man/man1`. On Windows, `installPlan` returns the documented PowerShell command `irm https://static.devin.ai/cli/setup.ps1 | iex` as an `unsupported_platform` plan without running it.

Two vendor installer behaviors shape preflight and completion:

- The vendor script refuses to overwrite a regular non-symlink file at `~/.local/bin/devin`, so `devinRuntime.installPlan` rejects an existing regular file at the unpinned POSIX install path with `unsupported` and reason `configuration` before downloading.
- In non-interactive runs without a TTY, the trailing `devin setup` wizard exits `1` after linking `~/.local/bin/devin`. `planInstaller` verifies installation by re-running `devinRuntime.installation()` afterward rather than checking the script exit code, so OAR recognizes the linked binary when `devin --version` and `devin acp --help` pass.

**Update checks.** `devinRuntime.checkUpdate` resolves `realpath(command)`, reads the sibling `../distribution` marker file through the internal `readDevinDistribution` helper, and fetches the matching manifest:

| `distribution` marker | Manifest URL |
| --- | --- |
| `curl-bash`, `irm-iex` | `https://static.devin.ai/cli/current/manifest.json` |
| `curl-bash-enterprise`, `irm-iex-enterprise` | `https://static.devinenterprise.com/cli/current/manifest-enterprise.json` |
| `curl-bash-windsurfcom`, `irm-iex-windsurfcom` | `https://static.devin.ai/cli/current/manifest-windsurfcom.json` |

Installations from Homebrew `devin-cli`, the Devin Desktop bundle, or portal and federal installers have no supported `distribution` marker and return `{ kind: "unavailable", reason: "unsupported_installation" }`. OAR omits `upgrade` because `devin update` prompts for confirmation without a `--yes` flag.

### Authentication, providers, usage, and inventories

`WINDSURF_API_KEY` is the sole environment credential that `devin` reads. `DEVIN_API_KEY` does not appear in the binary, and `devin` ignores it.

`devinRuntime.authStatus` runs `devin auth status` with a 30-second deadline, accepts `timeoutMs`, and omits `localOnly`:

- `devin auth status` exits `0` across logged-out, corrupt, rejected, and logged-in states and ignores `WINDSURF_API_KEY`.
- When the effective environment sets a non-empty `WINDSURF_API_KEY`, OAR returns `{ kind: "unknown", source: "devin auth status", configured: ["environment: WINDSURF_API_KEY"] }` without validating or echoing the key.
- Otherwise, the internal `parseDevinAuthStatus` helper classifies `3000.12.57` outputs without retaining file paths, names, user or org IDs, or server URLs:
  - `Not logged in.` returns `logged_out`.
  - `Failed to load credentials:` returns `unknown`.
  - `User / team info:` appears only when the server status fetch fails after loading stored credentials. Lines matching `Failed to fetch from server: ... Authentication required` or `invalid api key` return `logged_out`, and transient failures matching `Failed to fetch from server:` or `Unavailable:` return `unknown` with `configured: ["stored credentials"]`.
  - Authenticated `devin auth status` prints `Logged in (via Devin).` or `Logged in (via API key).` followed by `Credentials:`, `User:`, `Account:`, and `Team settings:`. `parseDevinAuthStatus` returns `logged_in` with `method`, `credential` set to `"account"` for `"Devin"` or `"api_key"` for `"API key"`, `email` from `Email:` in `User:`, and `plan` from `Plan:` in `Account:`, omitting `email` and `plan` when absent.

Checks on `devin 3000.12.57` account for the absent members:

- **Login and logout.** OAR checked every CLI and ACP sign-in route on `3000.12.57`:
  - `devin auth login` without `--force-manual-token-flow` blocks on a 3-way `ratatui` mode selector over pipes with no URL printed, and browser login invokes `/usr/bin/open` directly on macOS through `open-5.3.3` without consulting `BROWSER` or `PATH`.
  - `devin auth login --force-manual-token-flow` prints a PKCE URL with `cli_pkce_marker=1` without opening a browser when `/api/healthz` returns `"OK"`, then opens `/dev/tty` directly through `crossterm` for cursor-position queries and masked `Code:` input. In a detached non-TTY session with no controlling `/dev/tty`, it ignores piped stdin and exits `1` with `Error: Failed to read code - user canceled` on stderr. Inside a PTY it completes PKCE code exchange and writes `credentials.toml`, yet two obstacles block `Runtime.login`. First, whenever `$XDG_DATA_HOME/devin/credentials.toml` already exists on disk, even if the server rejects the stored key with HTTP `401`, `devin auth login --force-manual-token-flow` exits `0` with `You are already logged in. Use 'devin auth logout' first to re-authenticate.`, which conflicts with OAR's rule never to clear stored credentials before new ones exist. Second, `openScriptTerminal` runs on Linux only because macOS BSD `script` fails on socketpair stdin in `#752` and Windows has no `script` utility.
  - ACP `authenticate` with `devin-browser` opens a loopback callback and invokes `/usr/bin/open` directly, never emits the sign-in URL over ACP, and fails with JSON-RPC `-32603` and `Could not open browser for authentication` when browser launch is unavailable.
  - ACP `/login` accepts an API key only inside `session/prompt`.
  - `devin auth logout` removes local `$XDG_DATA_HOME/devin/credentials.toml` and plugin caches with exit `0` and no remote revocation. OAR omits `logout` alongside `login` per [the login contract](../spec/login.md#logout).
- **Providers.** `devin --help`, `devin doctor --json`, `$XDG_CONFIG_HOME/devin/config.json`, and ACP `available_commands_update` offer no third-party provider configuration or per-provider credential store. ACP `/billing` only toggles whether a linked provider plan pays for its models, so OAR exports no provider-auth facade.
- **Account usage and limit resets.** `devin --help`, `devin auth --help`, `devin doctor --json`, and ACP `available_commands_update` offer no account quota window or limit-reset call. ACP `/context` and `/session-stats` report session-level state only, so `accountUsage` and `redeemLimitReset` stay absent.
- **Independent inventories.** `skills` runs the native CLI catalog described below. `commands`, `mcpServers`, and `tools` remain `unsupported` with `transport_unavailable`. `devin mcp list --json`, `devin plugins list`, and session-scoped `available_commands_update` remain unmapped.

### Independent skills

`skills(installation, { cwd, env, timeoutMs })` runs `devin skills list --json`
without starting ACP or submitting a prompt. The reader returns `discovered`
metadata: `name`, `description`, native `provider` as `source`, and non-empty
`base_dir` as `path`. That path is the native skill directory, not a fabricated
`SKILL.md` filename. `triggers` determines `disableModelInvocation`: it is true
when the native list does not contain `model`. `userInvocable` is true when
that same list contains `user`, false otherwise; both fields stay absent if
the list is absent.
Skill bodies and native warning/error text are not returned.

`provider: "Builtin"` maps to `scope: "builtin"`. Other measured providers
(`Devin`, `Claude`, `Windsurf`) identify a configuration format, not ownership:
the same label occurs in user and project roots. Their scope remains absent;
this catalog supplies no plugin identity. No path-based ownership guess is added.

The [Linux 3000.12.57 comparison](../../experiments/devin-skills/README.md)
found three bundled skills in an empty home and eight user/project fixtures
through native discovery. It also found malformed YAML silently omitted from
the native list. Only non-empty native `errors` on returned rows set
`partial: true`; warnings alone do not. Silently rejected files are not part of
the native catalog and cannot be diagnosed from this result.
An empty native list is still a successful query; invalid JSON, malformed rows,
nonzero exit and timeout remain `unavailable`, never a successful empty list.
The reader terminates and awaits its owned process on success and failure.

## Orientation query costs and reader environment

`listModels` runs `devin acp` in `listingCwd(options)`, which uses `options.cwd` or `process.cwd()`. That call initializes `$XDG_DATA_HOME/devin/cli/sessions.db`, `$XDG_CONFIG_HOME/devin/config.json`, and a lock file under `session_locks/`, and scans `cwd` rules and skills before `session/delete` removes the session entry. `OAR_DEVIN_BIN`, `HOME`, `XDG_*`, and `WINDSURF_API_KEY` in `env` overlays apply to installation checks, auth status, model listing, and sessions without mutating `process.env`.

`skills` can create the native config, installation identifier, telemetry state,
logs and plugin lock files. The isolated fixture retained its existing config
bytes and created no session database or credential file. The command attempts
feature-flag and telemetry connections even without an account. No disabling
switch was found in 3000.12.57 CLI help or the official
[command](https://docs.devin.ai/cli/reference/commands) and
[configuration](https://docs.devin.ai/cli/reference/configuration/config-file)
references. The test blocks those attempts with a closed loopback proxy; OAR
does not impose a proxy or override the user's native settings.

Default `orient()` depths do not read skills. Explicit
`include: ["customization"]` can do so at any depth and already opts into native
side effects, including network attempts; the auth reader's `localOnly`
declaration does not apply to inventory readers. Devin's brand source labels
do not establish user-owned customization counts.

## Verification and open gaps

- [Native skill catalog comparison](../../experiments/devin-skills/README.md): Linux 3000.12.57, empty and populated homes, native/public metadata parity, malformed-file omission, environment isolation and side effects. Native macOS and Windows skill queries remain unmeasured.

- [`experiments/devin-acp/probe.ts`](../../experiments/devin-acp/probe.ts) runs an isolated zero-token CLI and ACP handshake probe verified against `devin 3000.12.57` on macOS arm64 on 2026-11-13.
- [`experiments/devin-acp/login-probe.ts`](../../experiments/devin-acp/login-probe.ts) exercises the CLI login, `authStatus`, and `logout` flows against a local synthetic PKCE and ConnectRPC server on `devin 3000.12.57` on macOS arm64 on 2026-11-14. It verifies detached non-TTY failure, PTY `--force-manual-token-flow` PKCE sign-in, authenticated `Credentials:`, `User:`, `Account:`, and `Team settings:` status output, `401`-rejected `credentials.toml` re-login refusal, and `devin auth logout`.
- Unit and fake-ACP suites cover version and path discovery, installer preflight, `distribution` manifest resolution, `authStatus` parsing across missing, corrupt, server-rejected, unreachable, and authenticated `Devin` and `API key` states, `WINDSURF_API_KEY` handling, `listModels` shared deadline, `session/delete` cleanup, empty-catalog auth disambiguation, `-32603` open and turn auth mapping, `bypass` mode switching, synchronous `model` and `thought_level` config options, `resumeKeepsSessionCwd` refusal, `isResumeNotFound` `-32016` mapping, and refused session options.
- `devin acp` speaks ConnectRPC protobuf on `/exa.*` routes rather than OpenAI or Anthropic HTTP, so `aimock` does not cover Devin turns. Live authenticated inference against Cognition servers, `session/prompt` rate-limit, quota, and billing payloads, mid-turn prompt behavior, tool-call detail projection, child attribution, and Linux and Windows installer runs remain unverified.
