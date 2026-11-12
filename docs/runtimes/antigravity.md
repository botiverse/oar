# Antigravity

OAR uses the standalone **agy CLI's native ACP entry point**, available from
1.5.0. It no longer launches the separate `agy_acp_server` archive or its
companion harness. The latest Linux check is CLI **1.5.6**, 2026-11-11:
17 behavior cases and all twelve vendor cases pass with an isolated HOME
and a local scripted Gemini provider ([daily report](../../experiments/runtime-version-checks/2026-11-11.md#antigravity-156)).
See the [1.5.0 migration report](../../experiments/antigravity-cli-acp-2026-11-05.md)
for native controls, retained limitations and the host migration checklist.
The new-version runs do not establish account-specific or macOS/Windows behavior.

Independent inventories and account usage are not implemented. Login, status
and logout drive agy's own ([login](#login)); see
[account policy](#process-ownership-installation-and-account-usage). See the
[query contract](../spec/inventory.md) and [native inventory evidence](inventory.md).

## Native concepts and calling interfaces

[`agy acp`](https://antigravity.google/docs/cli/acp) provides a persistent
JSON-RPC connection over stdio. A native session has a conversation id,
workspaces, permission mode, model family and thought level. Native
`session/prompt`, `session/cancel`, `session/resume`, `session/load`,
`session/list`, `session/close` and config options provide the host controls.
The CLI also has interactive and stream-json entry points; OAR uses ACP.

On 1.5.0, initialize ([November 4 probe](../../experiments/runtime-version-checks/2026-11-04.md#agy-cli-150-new-public-acp-entry-point))
reports `protocolVersion: 1`, `agentInfo` named
`Antigravity ACP Server`, load/resume/list/close and additional-directory
capabilities, image and embedded-context support, and native system-prompt
append metadata. HTTP MCP is advertised with `--process-per-session`;
without that flag the native initialize response does not advertise HTTP MCP.
Advertised features are not automatically OAR promises: additional
directories, for example, fail the primary-cwd contract below.

Permission modes are `default`, `accept-edits` and `plan`. OAR starts the
CLI with `--dangerously-skip-permissions` under the host-approved tools
contract; it does not select `yolo`, which the new CLI does not offer.
The CLI uses its existing configuration and login. OAR sends no synthetic
`authenticate` request.

## High-level mapping to OAR

OAR exposes an ordered record stream per Session. ACP messages are retained
verbatim in frame `native`; projected events describe only what they say.
Control calls have request/response records.

| Native concept | OAR mapping |
| --- | --- |
| Executable | One `agy acp --dangerously-skip-permissions --process-per-session` process per Session, launched in `cwd` with the env overlay. |
| Conversation | `Session.id` is the native id; `resume` uses `session/resume`, without replay. |
| Prompt and immediate input | `prompt()` starts a turn; `steer()` sends another prompt into the active native loop. The newest prompt answer ends that loop. |
| Queue | OAR's volatile FIFO, not a durable native queue; withdrawal before dispatch is supported. |
| Cancel and dispose | `session/cancel`; native close when available during disposal, then owned process-tree cleanup. |
| Model and effort | Native config responses and updates; selectors `model` and `thought_level`. |
| Child attribution | `opaque`. No verified CLI child identity mapping; OAR does not invent child sessions or turn ids. |
| Compaction | The CLI advertises `/compact`, but no structured completion/attribution contract has been verified. `manualCompaction` is declared `unsupported`; no `Session.compact` member. |

Implementation: [profile](../../packages/oar/src/runtimes/antigravity/session.ts),
[ACP session kernel](../../packages/oar/src/shared/acp/session.ts),
[turn handling](../../packages/oar/src/shared/acp/turns.ts) and
[projection](../../packages/oar/src/shared/acp/projection.ts).

## Capability details

### Session creation and resume

The CLI reads `$GEMINI_HOME/antigravity-cli/settings.json`, its native login
and conversation state. `GEMINI_HOME` defaults to the user's `.gemini`
directory. The local-provider fixture uses `modelProvider: "gemini"`, a
dummy `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`; it never uses a real
account. Give a session a separate HOME/GEMINI_HOME when isolation is needed.
This adapter does not promise to exclude user configuration while retaining
login and history.

OAR sends `cwd`, MCP servers and any supported append metadata on every open.
Requested model and effort values are then applied through native config
options. OAR waits for each option's response and matching configuration
notification before applying the next setting, so a delayed model snapshot
cannot overwrite the later effort selection. Missing or contradictory
confirmation rejects the open within its deadline. Opening requests have a
30-second deadline; an opening failure rejects construction and cleans up
the process.

Resume retains native history but does **not** retain the previous open's
model/effort or appended instructions in the measured CLI control: omission
uses the CLI defaults. Pass the intended complete configuration again.
There is no `resumedSessionOptions` declaration for this runtime.

```ts
const options = { cwd, model: "gemini-3.8-flash", effort: "low", appendSystemPrompt: instructions };
const first = await antigravityRuntime.session(installation, options);
// Complete a prompt so native session/list can confirm the saved cwd.
// After disposing first:
const resumed = await antigravityRuntime.session(installation, { ...options, resume: first.id });
```

The native resume ignores a different supplied `cwd` and keeps the saved
working directory. Before any resume/load request, OAR requires a native
`session/list` entry with a non-empty saved cwd equal to the requested cwd.
A different or unconfirmed directory gives `UnsupportedOptionError("cwd", ...)`.
Missing listing capability, an incomplete listing and an unlisted id all
refuse construction rather than silently opening elsewhere
([resume-cwd contract](resume-cwd.md)). A listing transport/authentication
failure retains its existing error classification and prevents resume;
authentication failure does not mean the saved directory is unusable. On
Windows, the CLI's URI-style `/D:/path` is compared as `D:\path`; POSIX paths
and filesystem aliases still use their native directory semantics.

On 1.5.0, a session closed before its first prompt is absent from the list,
yet native resume/load can reopen it at the old cwd without reporting that
cwd in the response. Conversely, loading a genuinely absent id can return
success with that id. Therefore list absence does not establish
`SessionNotFoundError`, and load is not a safe fallback. An unlisted existing
id and an absent id receive the same cwd refusal; a host can start a new
session but cannot infer that the old history is gone. Session inventory is
not exposed as a public query. Concurrent controllers for the same id and
continuing in-flight work across processes remain unverified.

### Prompt, steering, queueing, and abort

`prompt()` accepts once the RPC is sent, or rejects `busy` while an active
turn or queued input owns the next slot. Image-only input goes as ACP image
blocks without an invented text prompt; the native Gemini request preserves
the image. Unsupported audio is not sent.

**Steer is supported.** With the first provider response held, a second
native prompt entered the next model request in the same tool loop, before
its final answer; that request retained the original prompt and the tool
result too. The CLI answered the *original* prompt early, while that
provider response was still held. OAR therefore marks a steer as
superseding the earlier prompt: the earlier answer is still a frame, but
cannot report `turn_ended` or release the busy gate. The latest prompt's
answer settles the turn. An invalid-params answer (`-32602`, verified with an
empty image) refuses only that steer, even if the original prompt's natural
completion arrives first. Its `input_dropped` event does not turn the original
success into a failure.

OAR checks that the same turn is still active and not being aborted after
waiting for startup and immediately before SDK dispatch. If it ended, was
replaced, or was interrupted meanwhile, `steer()` rejects `no_active_turn`
without sending another native prompt. Its `accepted` receipt follows
dispatch; a waiting steer does not keep the original turn open. Image loading
is synchronous and does not create another asynchronous wait.

A replacement failure after every earlier prompt has replied can report the
loop's failure or cancellation without relabeling that input as refused.
Killing the accepted steer's worker on Linux yielded `-32603` while the outer
ACP process stayed alive. OAR retains the accepted input and reports a failed
turn with the native error; the error has no structured worker-exit category,
so its failure class stays `unknown` and no root `exited` record is fabricated.
[Native controls and before/after results](../../experiments/antigravity-steer-outcome/README.md)
include the deliberately delayed invalid request used to reproduce the race.
The vendor regression asserts both prompt texts and the tool result, one
completion and rejection of a premature new prompt. Protocol regressions
cover both refusal orders and the accepted worker failure.

`queue()` holds input in memory (`durable: false`) and sends it FIFO when
active work ends. The dispatch is recorded as a prompt carrying the original
queue submission, so it is one logical input. `withdraw(inputId)` removes an
input before dispatch; it returns `not_queued` afterward. Held inputs are
lost when their owning OAR process exits.

`abort()` sends `session/cancel`. A native prompt answer with
`stopReason: "cancelled"` produces an aborted turn. Other stop reasons map
to completion. The common ACP fallback terminates the owned process when
native cancellation does not settle within ten seconds. The behavior suite
checks cancellation and disposal with the CLI/local provider.

**One input is limited to 185,000 bytes.** agy 1.5.6 drops the end of a
single input past about 192,000 bytes and says nothing: with the
instruction at the top and a code word at each end, a 185,000-byte prompt
got both words back and a 200,000-byte one only the first (a signed-in
machine, 2026-11-12). Its `transcript_full` showed the input cut at 192,159
bytes with `<truncated 58527 bytes>`, while the conversation database kept
it whole; a third-party bridge had reported the same limit for 1.5.4. So a
prompt, steer or queued input whose text is longer than 185,000 UTF-8 bytes,
the largest measured to arrive whole, is refused before it is sent
(`unsupported`, `failure: input_too_large`), and the caller keeps the whole
input. The bound is OAR's, not agy's cut point, which was not measured
exactly ([probes and results](../../experiments/antigravity-input-size-2026-11-12/README.md)).

### Observation, children, and history

Text and tool updates project through the shared ACP mapping; unrecognized
frames remain available verbatim. Detail strings are bounded at 10,000
characters, while `native` retains the full value. Resume does not replay
history. A local-provider CLI child control reached the child model but kept
the observed tool/text events under the parent's session id; no native child
identity link was established. Attribution remains `opaque`, and no
real-account child run was performed.

No `usage_update` or prompt usage was observed in the local CLI controls.
OAR does not fabricate token or context totals. A native `/compact`
available-command entry alone does not prove compaction completion.
The native failure regression still records the observed completed-looking
turn after a rejected provider key, rather than reclassifying agent text as
an error. See the versioned
[failure evidence](../spec/runtime-matrix.md#failure-evidence).

### Models, instructions, and context

`listModels()` initializes ACP and opens a temporary session without a
prompt, reads its model selector, and terminates the process. It requests
`session/close` only when advertised; a close failure does not discard an
already obtained catalog ([query costs](#orientation-query-costs)).

1.5.0 reports grouped model ids such as `gemini-3.8-flash`, with a separate
`thought_level` config option in category `thought_level`. OAR selects each
through `session/set_config_option` and folds the returned values. Both its
answer and corresponding `config_option_update` must confirm the requested
selection before open returns; an empty `session/set_model` acknowledgement
would not establish model readback. See the
[notification-order controls](../../experiments/antigravity-cli-acp-2026-11-05.md#model-notifications-must-settle-before-effort).
The provider regression verifies `LOW` and `HIGH` thinking levels for the
explicitly selected Gemini Flash family on creation and resume. Other
families may encode effort as a thinking budget instead.

`appendSystemPrompt` is sent in
`_meta.antigravity.systemPrompt.append`, only when initialize advertises
`systemPrompt.append`. It supplements the built-in instructions. A new
append replaces the old append on resume; omission restores the default
prompt. `systemPrompt` replacement is refused. No resume timing declaration
is published without the broader compaction evidence required by that
contract.

### Session MCP servers

Credential-free stdio and HTTP `mcpServers` attach through ACP on creation
and resume. HTTP needs the per-session worker flag included by OAR. Pass
servers again on resume. Native CLI controls verified stdio and HTTP tool
execution and the returned tool content.

Session-provided tools use direct names `mcp_<server>_<tool>` and require
the native `toolSummary` argument. User-configured servers from
`$GEMINI_HOME/config/mcp_config.json` remain lazy, accessed through
`call_mcp_tool {ServerName, ToolName, Arguments}`. The native schema for this
wrapper rejects an extra `toolSummary`. A session entry replaces a user
entry of the same name; non-clashing user servers remain and their config
file is unchanged.

The [shared activity mappings](../spec/record-stream.md#the-rules) account
for Antigravity's direct `mcp_<server>_<tool>` namespace and capitalized
argument keys: `run_command` uses `CommandLine` / `toolSummary`, and its
`read_file` and `edit_file` use `Path`. ACP inputs retain the whole JSON
object, including `text` and `toolSummary`, without the output preview's
character limit. The
[recorded 1.5.2 inputs](../../experiments/tool-activity-audit/README.md#follow-up-decisions-and-input-fix)
are the regression evidence; unrecorded tool names remain `other`.

**`mcpToolsListChanged: "none"` on 1.5.0.** After the HTTP server reports a
changed tool list, the connected CLI neither lists again nor updates the
next provider request's tool catalog. This differs from the retired service.
The regression binds the declaration to both observations.

**MCP credentials remain refused.** A direct native control found synthetic
env/header values in
`$GEMINI_HOME/antigravity-cli/conversations/<id>.db` and its WAL after close.
OAR refuses entries containing non-empty `env` or `headers` before launch
(`refusedSessionOptions.mcpServerCredentials`). This includes
`serveMcpTools` entries, which carry a bearer token. Credential-free entries
still attach. The new directory does not remove the persistence problem
tracked in [issue #392](https://github.com/botiverse/oar/issues/392).

**A stdio server can take its credential from the session environment
instead**, as a host's own choice. agy 1.5.6 starts a session's stdio
servers on `session/new` with its own process environment, so a value in
`SessionOptions.env` reaches a credential-free entry's process (a synthetic
marker, on a signed-in machine, 2026-11-12). The same marker was not found
afterwards in `~/.gemini` or `~/.cache/antigravity` (132 files read), which
shows only that this run left no copy, not that agy never stores its
environment. OAR does not move an entry's `env` there by itself: the
session environment also reaches agy's own tools, so a shell command the
model runs can read the value, which an entry's `env` would have kept to the
server. A host that accepts that puts the value in `SessionOptions.env` and
attaches the entry without `env`. HTTP `headers` have no such route.

### Process ownership, installation, and account usage

OAR owns the CLI and its session workers, uses native close when available,
and cleans up the owned process tree on disposal. Persisted conversations
are not deleted. Host-exit and descendant limitations are the
[shared process contract](../spec/record-stream.md#the-rules).

Discovery checks `OAR_ANTIGRAVITY_BIN`, PATH `agy`, then the official install
location: `~/.local/bin/agy` on Linux/macOS or
`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows (with the standard user AppData
fallback). Without an explicit override, an unsupported old PATH copy does
not hide a supported CLI at the official install location. An override is
exclusive: OAR never silently substitutes a different executable for it.
`--version` must report one unambiguous stable release of at least 1.5.0;
only the bare version line is accepted; additional notices and prereleases
are rejected.
Older CLI versions can return success and help for an unknown `acp` command,
so help's exit code alone is insufficient. An unsupported selection reports
its path and recognized version, with a migration instruction; the retired
`agy_acp_server` build stamp does not satisfy the CLI version gate.

The [official CLI installer](https://antigravity.google/docs/cli) supplies
`installPlan` and `install` on Linux/macOS:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

The plan names its source and command. Preflight checks curl/bash and write
access to `~/.local/bin` and `~/.cache/antigravity`;
the vendor installer may also modify `~/.bashrc` and `~/.zshrc`, whose
writability is not a prerequisite. It verifies the
downloaded release checksum. The installer exits without upgrading an
existing CLI, so an unsupported selected executable or a missing pinned
path gives `unsupported` with reason `configuration` before any download.
Update that copy or correct the override first; OAR does not remove it. On Windows OAR returns the
vendor's PowerShell instruction as an unsupported-platform plan; it does
not execute that unverified installer. The Linux isolated-home smoke test
verified a new installation, discovery with the install bin off PATH, and
an idempotent second install.

`checkUpdate` reads the CLI's platform manifest and counts only a newer
release. OAR has no `upgrade` method for this runtime; the native CLI has
`agy update`. Existing CLI auto-update behavior is not disabled by the
product adapter (the test fixture disables it).

### Login

OAR drives Antigravity's own Google login, reads its status, and signs out
through agy's ACP `logout`. Verified on agy 1.5.5 (Linux, 2026-11-10; [launcher and input controls](../../experiments/antigravity-login/README.md)) up to the code prompt and
against the logged-out status; the full sign-in was done once by a person on
another machine through the CLI's interactive UI, which the status read
confirmed.

- `login` runs `agy acp --login` ("Log in with Google interactively, then
  exit"). It prints `Open this link in a browser to log in with Google:`, a
  `https://accounts.google.com/...` URL (relayed as `auth_url`), then `Then
  paste the authorization code, or the full URL of the page you land on, and
  press Enter:`; OAR asks the host with a `manual_code` prompt and writes the
  answer only to agy's stdin. agy keeps waiting on an empty line, so OAR asks
  again instead of sending one; agy itself prints `login cancelled: no
  authorization code was entered` only when its input ends. After exit 0,
  `agy models` decides: a login is `logged_in` (no account details), a sign-in
  refusal `not_logged_in`. agy ignores `BROWSER` and starts the platform
  launcher itself. On Linux it finds `xdg-open` on PATH, so for
  `openBrowser: false` the login child's PATH starts with a directory holding a
  launcher that does nothing (macOS `open` is treated alike, unverified). On
  Windows it runs `%SYSTEMROOT%\System32\rundll32.exe` by absolute path,
  which nothing on PATH replaces, so `openBrowser: false` there, like any
  platform where the launcher cannot be set up, is `unsupported`
  (`browser_suppression_unavailable`) before anything runs.
- `authStatus` runs `agy models`: exit 0 is `logged_in`; exit 1 with `Please
  sign in to view available models` is `logged_out`; anything else
  (network, a crash) is `unknown`. It is a remote call, not `localOnly`.
- `logout` sends ACP `logout` on a fresh `agy acp`. agy 1.5.5 declares it in
  `initialize` (`agentCapabilities.auth.logout`), answers `{}`, and removes its
  stored token file itself (checked in an empty HOME holding a placeholder
  file, 2026-11-11; [probe](../../experiments/antigravity-login/README.md#logout)).
  A build that does not declare it is `unsupported` (`version_unsupported`).
  `agy models` then decides, so a sign-in from elsewhere (a keyring entry
  agy keeps, an environment credential) reads `still_logged_in`. Whether agy
  also revokes the grant at Google is not observed. Print mode refuses
  `/logout` (`/logout is not available in print mode (it clears stored
  credentials, an effect that outlives the run)`), and OAR never deletes the
  token itself.

The CLI chooses where the token lives: on a machine without a keyring it was a
0600 file, `$GEMINI_HOME/antigravity-cli/antigravity-oauth-token`, and its
binary names keyring detection, so a desktop may differ. OAR reads neither.

The vendor's [FAQ](https://antigravity.google/docs/faq) warns that third-party
access using Antigravity login violates its terms and may lead to suspension
or termination, and recommends API keys; embedding `agy -p` in third-party
applications is also unsupported on consumer plans. OAR runs the CLI's own
login and its own ACP server rather than using the credential itself. Whether
a host's use of a consumer account fits those terms is the host's and the
user's call (decided for Raft by its owner on 2026-11-10;
[decision](../design/decisions.md#antigravity-consumer-login)). An API key
under its applicable terms avoids the question.

OAR neither copies nor deletes the retired service's credential or history
store. CLI conversations use a separate native directory; old service ids
are not migrated, and an unconfirmed saved cwd is refused as above.

## Disallowed tools

Non-empty `disallowedTools` is refused before launch. CLI 1.5.0 silently
ignores the retired service's `_meta.antigravity.disabledTools`; a direct
native control still offered `run_command` after it was named there. OAR
has no verified replacement denial channel and does not hide tool events
or fabricate an allowlist. Empty lists remain valid.

## Launch arguments

`launchArgs` follow OAR's own arguments, pass unchecked and are never
recorded. Give them again on resume. Use the native CLI's ACP arguments,
not flags for the retired Python archive.

## Additional directories

Non-empty `additionalDirectories` is refused. CLI 1.5.0 advertises and adds workspace roots, but can select an extra
root as the command working directory. With process and session cwd
`z-original` plus extra root `a-extra`, native `session/list` and an actual
`run_command` running `pwd` both reported `a-extra`. Without the extra root
both reported `z-original`. That violates OAR's requirement to keep cwd
primary; merely observing the extra root in instructions is insufficient.

## Structured output

`outputSchema` is refused before launch. There is no verified final-output
schema channel through this adapter; tool parameter schemas are unrelated.

## User configuration

`userConfiguration: "exclude"` is refused before opening. No verified
mechanism separates user configuration from login and session history.
Omission and `"include"` retain native configuration.

## Other refused options

`goals`, `endTurnProcessesOnAbort`, `serviceTier` and `name` are refused
before launch: this adapter has no verified native channel for them
([declarations](../../packages/oar/src/runtimes/antigravity/options.ts)).

## Orientation query costs

Model listing creates a temporary native session, and can do native
configuration or account/catalog I/O, but submits no prompt. There is no
local auth-status reader or substitute login flow.

## Reader environment

`OAR_ANTIGRAVITY_BIN`, HOME and native config variables in the env overlay
apply to installation and model listing just as to sessions
([reader environments](../spec/orientation.md#environment)). An overlay
never rewrites the host process environment.

## Verification and open gaps

The [migration report](../../experiments/antigravity-cli-acp-2026-11-05.md)
links repeatable native controls and the runtime-specific vendor tests.
The local behavior suite covers prompt, steer, queue, cancellation, resume,
models, images and disposal as applicable. Required CI installs the pinned
CLI 1.5.0 archive on Linux, macOS and Windows, verifies its SHA-512, and runs
the behavior and vendor suites with an isolated home and local provider.
The manual sharing-evidence workflow uses the same installer. The local
Linux results do not stand in for CI's macOS/Windows runs.
Real-account inference and login, reliable child identity links, usage,
structured compaction and concurrent same-id controllers remain unverified.

Historical evidence stays versioned: the
[CLI 1.4.9 versus separate ACP 1.4.4 comparison](../../experiments/antigravity-steering-2026-10-29.md),
[separate ACP 1.4.5 checks](../../experiments/runtime-version-checks/2026-10-30.md#antigravity-145),
[tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md),
[additional-directory audit](../../experiments/additional-directories-2026-10-11.md),
[native settings probe](../../experiments/antigravity-native-settings.ts) and
[MCP permissions comparison](../../experiments/runtime-version-checks/2026-10-24.md#settings-persistence-and-tool-list-changes).
Their old service conclusions do not describe the new CLI adapter.
