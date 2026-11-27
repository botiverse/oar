# Devin

`devin acp` over stdio, one process per session. Facts below were measured on
`devin 3000.12.57` (macOS arm64, 2026-11-13/14; skills on Linux) in temporary
homes with synthetic servers and no real account
([ACP probes](../../experiments/devin-acp/README.md),
[skills](../../experiments/devin-skills/README.md)). The adapter in
[`packages/oar/src/runtimes/devin/`](../../packages/oar/src/runtimes/devin/)
is the reference for what OAR does; its declarations (`refusedSessionOptions`
with a reason for each, `sessionCapabilities`, the members present) are the
list of what is supported. This page keeps what the code cannot say: how
Devin behaves, and why OAR maps it this way.

## Where Devin differs from the contract

- **No steering.** `initialize` advertises `cognition.ai/midTurnPrompts`, but
  a second prompt mid-turn was never observed without a live account, so
  `Session.steer` is absent.
- **No manual compaction.** `/compact` appears in the command list with no
  completion signal to settle on.
- **Resume stays in the saved directory.** Devin ignores a different `cwd` on
  `session/load`, so OAR confirms the directory through `session/list` first
  and refuses a mismatch ([resume in another directory](resume-cwd.md)).
  A missing session fails `session/load` with `-32016` and
  `data["cognition.ai/errorKind"] = "session_not_found"`.
- **Refused options.** Each reason is in `refusedSessionOptions`. One is not
  obvious: `initialize` advertises `additionalDirectories`, but whether the
  primary `cwd` and tool scoping honor it is unverified.
- **Turn failures.** Only sign-in failures have been measured for Devin
  (logged out: `-32000`; bad key at open: `-32603` "Authentication
  required"). Rate-limit, quota and billing payloads need a live account to
  capture.
- **No login or logout.** Every native route needs a terminal or a browser
  Devin opens itself: `devin auth login` waits on an interactive selector;
  the manual-token flow reads its code from `/dev/tty` and refuses to run
  while any `credentials.toml` exists, even one the server rejects; ACP
  `authenticate` calls `/usr/bin/open` and never sends the URL. Logout without
  login is not offered ([login contract](../spec/login.md#logout)).
- **No account usage, limit resets or provider settings.** Devin has no
  native surface for them.

## Ending a turn's processes on abort

**What native leaves:** `session/cancel` ends the Devin turn (the prompt
answers `{"stopReason":"cancelled"}`) but the command the turn started keeps
running in the terminal OAR hosts, and the session takes the next prompt
either way.

**Mapped (opt-in):** `SessionOptions.endTurnProcessesOnAbort: true` opts into
the shared ACP cleanup, as for Grok: OAR associates each `terminal/create`
with the turn that asked for it; once an accepted abort's turn closes as
`aborted`, OAR stops that turn's terminals (their process groups) and records
one `cleanup` response on the abort request with the number signalled. Devin
can still read and release the terminals; an earlier turn's terminals and
child sessions are spared.

**Verified:** Linux x64, CLI 3000.14.30821, real account, one turn per run.
With the option, the turn's `terminal/create`
(`command: "sleep 8; touch <marker>"`, no `args`) was answered, the abort
answered `accepted`, the native turn ended `aborted`, and the abort request
recorded `{"kind":"cleanup","result":{"kind":"completed","signalled":1}}`;
the marker never appeared (11 s later) and the next prompt completed. Without
the option the same run's marker appeared and no cleanup was recorded.
Attribution and the record shape are also covered against a fixture
([test](../../tests/devin/turn-terminals.test.ts)).

## Authentication

On 2026-11-21, OAR 0.125.0 read `logged_in` on Devin Pro with CLI
3000.14.30821 (Linux) and listed 169 models. One prompt without a model
override completed on `swe-2-high`, the value of the opening model events
and of `Session.model()` before and after the turn. In a separate open
without a prompt, both the `session/new` reply and `config_option_update`
notifications reported the same model. The completed turn returned
`usage().value.total === null`.

`WINDSURF_API_KEY` is the only environment credential Devin reads;
`DEVIN_API_KEY` is ignored. `devin auth status` exits 0 in every state and
does not see the environment key, so with the key set OAR reports `unknown`
with the key as configured, without checking it.

Devin 3000.12.57 showed the signed-in user in `devin auth status`, then omitted the user section after the server rejected the login and after explicit logout. [Account controls](../../experiments/remembered-accounts/README.md).

## Session MCP servers

OAR accepts credential-free stdio and HTTP entries. It refuses entries with
`env` or `headers` because the native tool environment and storage boundary
are unverified. An earlier check covered only the SQLite store.

## Process ownership, installation, and update checks

The official installer is `curl -fsSL https://cli.devin.ai/install.sh | bash`
(macOS and Linux; Windows has a PowerShell command OAR does not run). Two
installer behaviors shape OAR's plan:

- it refuses to overwrite a regular file at `~/.local/bin/devin`, so OAR
  refuses that case before downloading;
- without a terminal its trailing `devin setup` exits 1 after linking the
  binary, so OAR judges the result by probing the installation again, not by
  the exit code.

Update checks resolve the real executable, read the `distribution` marker
at `../distribution` relative to its directory, and fetch that channel's
manifest. A missing or unrecognized marker makes the installation
unsupported for update checks; Homebrew, desktop and enterprise-portal
installs update through their own channel. There is no
`upgrade`: `devin update` asks for confirmation and has no `--yes`.

## Side effects of reading

`orient()` at its default depth reads neither of the following. Depth
`models` runs `listModels`; `include: ["customization"]` runs the skill
catalog.

Model listing opens a native session in the listing `cwd` without
prompting it, then sends `session/delete` when `initialize` advertises
`delete`, `session/close` when it advertises only `close`, and neither
otherwise. On 3000.12.57, `session/delete` removes the entry from
`session/list` and `sessions.db`; `session/close` unloads it but leaves the
row. Listing creates Devin's session database, config and a lock file. The
skill catalog can create config, telemetry and plugin-lock files and attempts
feature-flag and telemetry connections even without an account; no switch to
disable them was found.

## Verification and open gaps

CI has no `aimock` backend for Devin because it talks ConnectRPC to
Cognition's servers; live verification covers one Linux `3000.14.30821`
`logged_in` read, model list, an `swe-2-high` turn, and the
[abort cleanup](#ending-a-turns-processes-on-abort) above. Still open: rate-limit
and quota payloads, mid-turn prompts, tool-call detail, child attribution,
installer runs on Linux and Windows, and skill queries on macOS and Windows.

## Failures

ACP `-32000` maps to `auth` as for every ACP runtime (`[env]` observed on a
logged-out `session/prompt`: "Please log in to use Devin."). Any other JSON-RPC
error (`[env]` observed `-32603` at `session/new` with an invalid key) whose
message says authentication is required, the API key is invalid or the user is
not logged in also maps to `auth`: a `RuntimeFailureError` at open or model
selection, or a failed turn on `session/prompt`
([classifier](../../packages/oar/src/runtimes/devin/session.ts),
[failure evidence](../spec/runtime-matrix.md#failure-evidence)). `devin acp`
speaks ConnectRPC, so `aimock` cannot script its provider and no other failure
cause or reset time has been observed.
