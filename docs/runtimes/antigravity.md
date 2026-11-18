# Antigravity

OAR uses the standalone **agy CLI's native ACP entry point** (1.5.0 and
later), not the retired `agy_acp_server` archive or its companion harness.
Newest check: CLI **1.5.9** on Linux, 2026-11-14, 17 behavior cases and all
fourteen vendor cases with an isolated HOME and a local scripted Gemini
provider ([daily report](../../experiments/runtime-version-checks/2026-11-14.md#antigravity-159));
it does not establish account-specific or macOS/Windows behavior. The
[1.5.0 migration report](../../experiments/antigravity-cli-acp-2026-11-05.md)
has the native controls, retained limitations and host migration checklist.

Independent inventories are not implemented ([query contract](../spec/inventory.md),
[native inventory evidence](inventory.md)). Account usage is agy's own
`/usage` answer ([account usage](../spec/account-usage.md)). Login,
status and logout drive agy's own ([login](#login)).

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
| Context usage | Native `usage_update.used` and `.size` feed `usage.context` through the shared ACP projection. The 1.5.9 local-provider trace reports 0 of 1,048,576 tokens; nonzero accounting and every native update trigger were not verified. This is separate from account quota. |
| Child attribution | `opaque`. No verified CLI child identity mapping; OAR does not invent child sessions or turn ids. |
| Compaction | The CLI advertises `/compact`, but no structured completion/attribution contract has been verified. `manualCompaction` is declared `unsupported`; no `Session.compact` member. |

Implementation: [profile](../../packages/oar/src/runtimes/antigravity/session.ts),
[ACP session kernel](../../packages/oar/src/shared/acp/session.ts),
[turn handling](../../packages/oar/src/shared/acp/turns.ts) and
[projection](../../packages/oar/src/shared/acp/projection.ts).

## Unsolicited activity in CLI 1.5.10 and 1.5.11

[Isolated local-provider controls](../../experiments/antigravity-active-turns/README.md)
received background tool completion and subsequent model output after the
prompt's `end_turn`, with no further ACP lifecycle boundary. OAR retains
that content as outside-turn activity. Status stays idle with activity
timestamps, the view opens no turn, and abort returns `no_active_turn`.
The activity marker is not proof that the native work remains running.
A 1.5.11 control sent a new prompt during agy's own command: native received
and followed its new instruction; preceding activity stayed separate.
Internal database observations remain experimental because short busy
states can be missed and fully idle alone does not classify the outcome.

## Known gaps in CLI 1.5.9

The [Linux local-provider experiment](../../experiments/antigravity-native-gaps-2026-11-15/README.md)
observed two transport gaps. These are Gemini API-provider controls, not
Google-login account tests:

- **Failed turns look completed.** After a successful MCP call, injected
  401 `invalid_token`, 429 quota/rate-limit, HTTP 504 and cut SSE responses
  produce warning text followed by `end_turn`. OAR records `completed` and
  retains the original warning in its records. It does not classify text
  warnings or map an unobserved `refusal` to quota. Tracked upstream in
  [antigravity-cli#1570](https://github.com/google-antigravity/antigravity-cli/issues/1570).
- **Background completion is absent from the observed ACP stream.** A
  `run_command` outlived `end_turn`, finished, and triggered another model
  request. Its completion and later model reply did not reach ACP during
  the following 12 seconds, although a title notification did. The temporary
  conversation database contained both. OAR cannot report these absent
  updates; `end_turn` is not proof that all native work is idle. A later
  [slow disk-scan probe](../../experiments/antigravity-disk-scan/README.md)
  observed the missing completion and background reply delivered immediately
  after a new prompt, while subsequent prompts remained usable. Related
  upstream report:
  [antigravity-cli#1461](https://github.com/google-antigravity/antigravity-cli/issues/1461).

Product OAR reads ACP, not the CLI's internal SQLite/protobuf storage.
Database inspection here is experiment-only and does not establish a
supported event or completion interface ([design decision](../design/decisions.md#reading-a-runtimes-internal-conversation-database-2026-11-15)). Background-command observations
do not establish every subagent/scheduler path; attribution remains `opaque`.
A separate stalled stream had no answer within the experiment's 180-second
bound, which is not a measured native timeout.

## Capability details

### Session creation and resume

The CLI defaults to `~/.gemini/antigravity-cli/` for settings, native login
and conversations. **CLI 1.5.9 ignores `GEMINI_HOME` itself.** OAR translates a
non-empty effective `GEMINI_HOME` into `--gemini-dir <directory>` for every
ACP launch: sessions and resume, model listing, login, and logout. Settings
then live at `<directory>/antigravity-cli/settings.json`. Inherited values
and the environment overlay both apply; `null` removes an inherited value.
OAR leaves HOME and USERPROFILE unchanged.

`agy models` and print mode do not accept `--gemini-dir`. When GEMINI_HOME
names a different directory from the effective home plus `.gemini`, OAR
returns `authStatus: unknown` with an explanation and `accountUsage:
unsupported` with `reason: unsupported_auth_storage`, before launching
those commands. Login and logout still use their ACP interface; without a
status query, their native success report decides the result, without
account details. No query silently inspects another profile. Directory
comparison is lexical; a symlink alias can conservatively be unavailable.

To isolate **all** these operations, set HOME on Linux/macOS or USERPROFILE
on Windows, with GEMINI_HOME absent or naming that home's `.gemini`. This
selects the native state directory; it does not promise to disable a
platform keyring. The local-provider fixture uses `modelProvider: "gemini"`,
a dummy `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`, never a real account.
See the [1.5.9 directory and command controls](../../experiments/antigravity-native-gaps-2026-11-15/README.md).
This adapter does not promise to exclude user configuration while retaining
login and history.

OAR sends `cwd`, MCP servers and any supported append metadata on every open.
Requested model and effort values are then applied through native config
options. OAR waits for each option's successful response and a matching
configuration notification before applying the next setting. A conflicting
notification keeps the same request waiting for a later positive value;
it is not assumed to be stale. Initialize has its own 60-second deadline;
other bounded opening requests retain 30 seconds
([shared deadlines](../spec/runtime-matrix.md#acp-opening-deadlines)).
At that deadline, a last observed conflicting value refuses the open, while
no notification naming that option produces a timeout. A genuine mismatch
therefore takes up to 30 seconds to surface instead of failing on its first
notification. RPC failures and process exits still fail immediately. An
opening failure rejects construction and cleans up the process.

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
A different or unconfirmed directory gives `ResumeCwdError`, extending
`UnsupportedOptionError` on `cwd` with a typed [reason](resume-cwd.md).
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

On Linux with 1.5.9, a slow foreground `du` stopped on cancellation, but a
command already moved to the background survived an accepted abort even
though the native turn ended as `cancelled`. After an ordinary `end_turn`,
OAR rejects abort with `no_active_turn`; it does not treat the still-running
background command as an active root turn. A late `tool_call_ended` alone
also cannot reopen an idle turn, verified by replaying the captured frame.
In the live control it arrived after a new prompt was accepted, so the
session was already running; the report keeps that ordering explicit.
The scan runs in agy's worker process tree, with no OAR-hosted ACP terminal
requests. `dispose()` cleaned up the observed native and shell process
groups in all five
[disk-scan controls](../../experiments/antigravity-disk-scan/README.md).
These are CLI/local-provider observations, not a reproduction of the
reported macOS desktop UI hang.

**OAR bounds one input at 185,000 bytes.** Observed on agy 1.5.6 (a
signed-in machine, 2026-11-12): with the instruction at the top and a code
word at each end, a 185,000-byte prompt got both words back and a
200,000-byte one only the first; in an earlier round, `transcript_full` held
a 250,110-byte input cut at 192,159 bytes with `<truncated 58527 bytes>`,
while the conversation database kept it whole; a third-party bridge had
reported a cut near 192,000 bytes on 1.5.4. Inferred: agy can drop the end
of a long input without saying so. These observations do not show what the
model saw at either size, and agy's cut point was not measured. So a prompt,
steer or queued input whose text is longer than 185,000 UTF-8 bytes (the
largest measured input whose two code words both came back) is refused
before it is sent (`unsupported`, `failure: input_too_large`), and the
caller keeps the whole input
([probes and results](../../experiments/antigravity-input-size-2026-11-12/README.md)).

### Observation, children, and history

Text and tool updates project through the shared ACP mapping; unrecognized
frames remain available verbatim. Detail strings are bounded at 10,000
characters, while `native` retains the full value. Resume does not replay
history. A local-provider CLI child control reached the child model but kept
the observed tool/text events under the parent's session id; no native child
identity link was established. Attribution remains `opaque`, and no
real-account child run was performed.

1.5.8 and 1.5.9 controls observe the context updates described above (1.5.0
controls observed neither `usage_update` nor prompt usage); OAR does not fabricate
missing totals. A native `/compact`
available-command entry alone does not prove compaction completion.
A 1.5.9 `ask_question` call produced plain-text questions/options and
`end_turn`, with no permission request and no automatically chosen answer.
See [known gaps](#known-gaps-in-cli-159) for failed turns and background
commands. The
[experiment](../../experiments/antigravity-native-gaps-2026-11-15/README.md)
retains warnings, native frames, directory controls and read-only database
observations; see also the versioned
[failure evidence](../spec/runtime-matrix.md#failure-evidence).

### Models, instructions, and context

`Runtime.minVersion` is `1.5.0`, requiring a stable release. Model listing,
authentication status and account usage each enforce this floor before ACP,
`models` or `/usage` queries, even when the caller bypasses `installation()`.
If the executable snapshot lacks a version, only a bounded `--version`
query runs first. Old, prerelease or unreadable versions return
`version_unsupported` with `requiredVersion` and, when known,
`installedVersion`; authentication remains `unknown`, not logged out.
[The result fields](../spec/orientation.md#adapter-version-requirements)
let a host offer an upgrade without parsing the explanation. Inventories
remain unsupported on this interface and start no query process.

`listModels()` initializes ACP and opens one temporary session without a prompt.
It selects every canonical model from `configOptions.model.options` through
`session/set_config_option`, confirms the selected model, and reads that
response's `thought_level` menu. A confirmed absent menu means no effort fields;
a failed switch, unconfirmed selection or empty exposed menu yields that model's
`effortUnavailableReason`, never another model's levels. Only the original
current model's explicit effort can establish `defaultEffort`.

Before closing, listing restores the original model and effort and confirms both
through native readback. Unconfirmed restoration fails the entire listing.
When the initial selection cannot be restored from its reported fields, or the
first selection returns method-not-found, listing uses the original
`models.availableModels` combinations instead. Ambiguous combinations remain
native selectors with an explanation. This fallback is not used to conceal an
individual switch failure.

The cost is N selection requests for N canonical models, plus one model restoration
and, when initially exposed, one effort restoration. This still creates one native
conversation per listing. A signed-in Linux 1.5.10 account measured 1.5 to 8.5 ms per
selection, confirmed restoration, and unchanged defaults in a fresh session after
a separate leave-selected control. Flash exposed low/medium/high; Sonnet, Opus
thinking and GPT-OSS exposed no thought-level selector. That account had no
non-default Gemini model. Native startup
writes conversation state, summaries and logs and may access the network; this is
not a promise of no persistent writes. See the
[account evidence, costs and persistence limits](../../experiments/antigravity-model-menus/README.md#signed-in-result-and-product-readback).

On 2026-11-18 at 04:28 UTC, xxchan confirmed that Gemini 4 Hydrogen, selected as a
non-default model, shows its effort menu through `listModels()` on their signed-in
account (Raft Computer 1.25.7-rc.1, OAR 0.116). The `agy` version is unknown. This
confirms effort-menu visibility only.

Listing requests `session/close` only when advertised. Close failure alone does
not discard an obtained catalog; restoration failure always does
([query costs](#orientation-query-costs)).

1.5.0 reports grouped model ids such as `gemini-3.8-flash`, with a separate
`thought_level` config option in category `thought_level`. OAR selects each
through `session/set_config_option`, folds the returned values and confirms
them as described under [session creation](#session-creation-and-resume);
effort also checks the response's reported value. An empty
`session/set_model` acknowledgement would not establish model readback
([notification-order controls](../../experiments/antigravity-cli-acp-2026-11-05.md#model-notifications-must-settle-before-effort)).
Saved selectors from older catalogs can combine model and effort, for example
`gemini-3.8-flash-high`. An exact entry in the native model menu always wins
and is sent unchanged. Otherwise OAR requires one unambiguous native model
prefix, selects and confirms that model, then checks the suffix against that
model's newly returned `thought_level` menu. It sets and confirms that effort
only when advertised there. It never borrows the initial model's effort menu
for a different target model. An explicit conflicting `effort` throws
`UnsupportedOptionError`; an unknown or ambiguous selector or absent target
level throws `ModelConfirmationError`, with the catalog actually read.
`model()`, `effort()` and records retain the separate native values, not a
reconstructed composite id. Both creation and resume use this rule.

If model notifications still disagree when the deadline expires, OAR throws
[`ModelConfirmationError`](../spec/runtime-matrix.md#model-confirmation-failures),
carrying `requested` and the last notification's model string (`null` if it
is not a string). The diagnostic includes native `thought_level` when
the same notification reports it. For a composite selection, `requested`
remains the caller's original selector. The ordinary notification check does
not enumerate a catalog, so `catalogSelectorIds` is absent there. Missing notifications retain the configuration deadline error.
Native 1.5.0 and 1.5.9 config notifications contain no request id, update
sequence, timestamp or correlation metadata in the measured controls.
OAR confirms an observed value, not which setting caused it. It does not
add a quiet-period delay or retry. A conflicting update arriving after
confirmation remains an ordinary recorded native observation; this rule
cannot guarantee that the value will never change again. The
[reconstruction and native evidence](../../experiments/antigravity-config-notifications-2026-11-15/README.md)
distinguish the synthetic stale-before-correct scenario from native
observations, where that scenario has not been reproduced.
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

In 1.5.9, the native `name: mcp_<server>_<tool>` takes precedence over its
`title: Run mcp_<server>_<tool>` in OAR; the recorded tool name and MCP
activity classification retain the direct name.

Session-provided tools use direct names `mcp_<server>_<tool>` and require
the native `toolSummary` argument. User-configured servers from
`<gemini-directory>/config/mcp_config.json` remain lazy, accessed through
`call_mcp_tool {ServerName, ToolName, Arguments}`. The native schema for this
wrapper rejects an extra `toolSummary`. A session entry replaces a user
entry of the same name; non-clashing user servers remain and their config
file is unchanged.

**The first prompt can lack MCP tools on macOS with CLI 1.5.0.** An
intermittent native failure omitted the MCP tool catalog despite a successful
session-server preload. The observed failures used the same-name replacement
configuration above; whether other configurations are affected is unknown.
Twelve Linux configuration/version controls on 1.5.0 and 1.5.7 did not
reproduce it, and one [macOS ARM64 1.5.9 control](../../experiments/runtime-version-checks/2026-11-14.md#one-macos-159-control)
passed the same-name case once; neither establishes a macOS fix. No supported MCP readiness barrier has been verified: the observed
`session/new` replies contain no tool catalog, and no MCP-ready notification
was observed or found in the public ACP documentation. OAR therefore adds no
unverified wait or retry; the existing vendor regression remains intact.
See the [failure timeline and controls](../../experiments/antigravity-mcp-readiness/README.md).

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
`<gemini-directory>/antigravity-cli/conversations/<id>.db` and its WAL after close.
OAR refuses entries containing non-empty `env` or `headers` before launch
(`refusedSessionOptions.mcpServerCredentials`). This includes
`serveMcpTools` entries, which carry a bearer token. Credential-free entries
still attach. The new directory does not remove the persistence problem
tracked in [issue #392](https://github.com/botiverse/oar/issues/392).

**A stdio server can take its credential from the session environment
instead**, as a host's own choice. agy 1.5.6 starts a session's stdio
servers on `session/new` with its own process environment, so a value in
`SessionOptions.env` reaches a credential-free entry's process (a synthetic
marker, on a signed-in machine, 2026-11-12). A read-only search of
`~/.gemini` and `~/.cache/antigravity` afterwards (132 files) found no
plain-text copy of the marker; that says nothing of other files, paths or
encodings. OAR does not move an entry's `env` there by itself: the session
environment reaches agy's own tools as well (a shell command the model runs
can read it), a wider reach than one server's process, while an entry's
`env` keeps the persistence risk above. A host that accepts the wider reach
puts the value in `SessionOptions.env` and attaches the entry without `env`.
HTTP `headers` have no such route.

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
release. `upgrade` runs native `agy update` without stdin or a terminal and
reads the same executable's version before and after. A version refusal from
`installation()` retains `via: "executable"` and `command`, so a CLI below the
1.5.0 floor can be upgraded while remaining refused for sessions and readers.
An isolated Linux probe upgraded 1.4.9 to 1.5.9 and then re-probed it as available
([reproduction and evidence](../../experiments/old-cli-upgrade/README.md)).
Existing CLI auto-update behavior is not disabled by the product adapter
(the test fixture disables it).

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
0600 file, `<gemini-directory>/antigravity-cli/antigravity-oauth-token`, and its
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
configuration or account/catalog I/O, but submits no prompt. `authStatus`
runs `agy models`, a remote call (not `localOnly`). `accountUsage` runs `agy
models`, then `agy -p "/usage" --output-format json` (no agent turn, signed-in
1.5.7), and `agy -p "/credits"` only when every model group has a used-up
bucket ([account usage](../spec/account-usage.md)).

## Reader environment

`OAR_ANTIGRAVITY_BIN`, HOME, `GEMINI_HOME` and native config variables in the
env overlay apply to installation, model listing, login, logout, auth status
and account usage just as to sessions
([reader environments](../spec/orientation.md#environment)); a non-default
`GEMINI_HOME` limits auth status and account usage as described under
[session creation](#session-creation-and-resume). An overlay
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

## Independent skill discovery

`skills()` reads local metadata directly for CLI **1.5.10 and 1.5.11 on Linux
and macOS**.
It starts no process, performs no authentication query or network request,
and works while signed out. The result remains `view: "discovered"`; no skill
body is returned or executed. Windows and unverified versions retain the guarded native
`agy --output-format json --print=/skills` reader.

The verified file reader follows workspace aliases (`.agent`, `.agents`,
`_agent`, `_agents`) from the repository root to the requested directory,
then the global CLI, config and legacy skill directories. Workspace discovery
uses the physical working directory. Manifest containment uses resolved roots and targets while returned
manifest paths keep their declared spelling. Linked
skill directories are followed. It reads skill and
plugin manifests, applies native duplicate precedence and invocation flags,
and includes only the native builtin mounts already materialized on disk.
`disable-slash-command: true` winners are omitted, while
`disable-model-invocation: true` entries remain with that flag. Both readers
report `userInvocable: true` for every listed entry, including model-hidden
skills. Slash-command-disabled skills stay absent rather than appearing with
`userInvocable: false`. The [invocation controls](../../experiments/skill-invocability/README.md)
compare the pinned native fallback and file-reader catalogs. Plugin names
come from their manifests; other scope stays unknown. Missing builtin files
are not initialized or repaired. The file reader always returns `partial: true`
because it omits the conditional `native_swarm` builtin: native sometimes
omits that mount even while its file exists and saved plugin settings agree.
Other discovered skills named `swarm` remain visible. The mount will be added
only after its native selection rule is verified.
A custom `GEMINI_HOME` that differs from the effective home's `.gemini` remains
`unsupported/scope_unavailable`.

The [file-reader comparison](../../experiments/antigravity-file-skills/README.md)
records native 1.5.10/1.5.11 controls for roots, manifests, YAML, plugins,
duplicates, signed-out reads and MCP startup, plus an unresolved native builtin
omission observed during development. The separate pinned 1.5.11 CI comparison
preserves the existing 1.5.0 ACP baseline. Windows CI asserts the native reader
and signed-out guard. A Windows junction-cwd comparison exposed different
workspace discovery; Windows will use the file reader only after that rule
is measured and the full comparison passes.

On Windows and for other versions, print mode can initiate login, so OAR first checks
`agy models` authentication. Signed-out reads return
`unavailable/not_authenticated`; unknown authentication returns `query_failed`.
The authentication and print calls share the query deadline and set
`AGY_CLI_DISABLE_AUTO_UPDATE=true` (`1` does not disable the native updater).
OAR validates the native success envelope, empty conversation ID, zero turns
and command name before mapping metadata. Malformed output fails the query.

That native fallback can initialize builtin files, logs and an empty history
database, reformat settings, access the network and start configured MCP
servers. With isolated synthetic configurations, both 1.5.10 and 1.5.11 started
a global MCP child during `/skills`; the workspace-only marker was not started.
Neither file reader started either marker. These observations do not establish
the behavior of every MCP configuration or other CLI versions.
[Earlier native-query evidence](../../experiments/antigravity-skills/README.md)
retains the signed-out guard, history and network controls. Commands, tools and
MCP inventories remain unsupported on this adapter.
