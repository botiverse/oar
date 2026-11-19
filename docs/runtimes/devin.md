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
- **Turn failures.** Only sign-in failures are recognized (logged out:
  `-32000`; bad key at open: `-32603` "Authentication required"). Rate-limit,
  quota and billing payloads need a live account to capture.
- **No login or logout.** Every native route needs a terminal or a browser
  Devin opens itself: `devin auth login` waits on an interactive selector;
  the manual-token flow reads its code from `/dev/tty` and refuses to run
  while any `credentials.toml` exists, even one the server rejects; ACP
  `authenticate` calls `/usr/bin/open` and never sends the URL. Logout without
  login is not offered ([login contract](../spec/login.md#logout)).
- **No account usage, limit resets or provider settings.** Devin has no
  native surface for them.

## Authentication

`WINDSURF_API_KEY` is the only environment credential Devin reads;
`DEVIN_API_KEY` is ignored. `devin auth status` exits 0 in every state and
does not see the environment key, so with the key set OAR reports `unknown`
with the key as configured, without checking it.

## Session MCP servers

Stdio and HTTP entries are accepted with their `env` and `headers`. Devin
was checked not to write those values to its SQLite store under
`$XDG_DATA_HOME/devin`.

## Process ownership, installation, and update checks

The official installer is `curl -fsSL https://cli.devin.ai/install.sh | bash`
(macOS and Linux; Windows has a PowerShell command OAR does not run). Two
installer behaviors shape OAR's plan:

- it refuses to overwrite a regular file at `~/.local/bin/devin`, so OAR
  refuses that case before downloading;
- without a terminal its trailing `devin setup` exits 1 after linking the
  binary, so OAR judges the result by probing the installation again, not by
  the exit code.

Update checks read the `distribution` marker beside the real binary and fetch
that channel's manifest. Homebrew, desktop and enterprise-portal installs have
no marker and are reported as unsupported installations. There is no
`upgrade`: `devin update` asks for confirmation and has no `--yes`.

## Side effects of reading

Model listing opens a native session in the listing `cwd` and then deletes
it (or closes it, which keeps its database row, when Devin offers no delete).
This creates Devin's session database, config and a lock file. The skill
catalog can create config, telemetry and plugin-lock files and attempts
feature-flag and telemetry connections even without an account; no switch to
disable them was found. Default `orient()` depths read neither.

## Verification and open gaps

Live authenticated turns are unverified: Devin talks ConnectRPC to
Cognition's servers, which `aimock` cannot stand in for. Still open: rate-limit
and quota payloads, mid-turn prompts, tool-call detail, child attribution,
installer runs on Linux and Windows, and skill queries on macOS and Windows.
