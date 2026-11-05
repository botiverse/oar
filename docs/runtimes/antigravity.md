# Antigravity

OAR uses the standalone **agy CLI's native ACP entry point**, available from
1.5.0. It no longer launches the separate `agy_acp_server` archive or its
companion harness. The current evidence is CLI **1.5.0**, Linux x64,
2026-11-05, with an isolated HOME and a local scripted Gemini provider.
See the [migration report](../../experiments/antigravity-cli-acp-2026-11-05.md)
for native controls, retained limitations and the host migration checklist.
These runs do not establish account-specific or macOS/Windows behavior.

Independent inventories, account usage and OAR login/status/logout are not
implemented. See the [query contract](../spec/inventory.md) and
[native inventory evidence](inventory.md).

## Native concepts and calling interfaces

[`agy acp`](https://antigravity.google/docs/cli/acp) provides a persistent
JSON-RPC connection over stdio. A native session has a conversation id,
workspaces, permission mode, model family and thought level. Native
`session/prompt`, `session/cancel`, `session/resume`, `session/load`,
`session/list`, `session/close` and config options provide the host controls.
The CLI also has interactive and stream-json entry points; OAR uses ACP.

On 1.5.0, initialize reports `protocolVersion: 1`, `agentInfo` named
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

The [November 4 probe](../../experiments/runtime-version-checks/2026-11-04.md#agy-cli-150-new-public-acp-entry-point)
verified only the new CLI ACP initialize response. The November 5 migration
report above adds session and control evidence. The older CLI/service
comparison remains [dated evidence](../../experiments/antigravity-steering-2026-10-29.md),
not a description of the current adapter.

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
| Compaction | The CLI advertises `/compact`, but no structured completion/attribution contract has been verified. No `Session.compact` member. |

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
options, whose responses confirm the selection. Opening requests have a
30-second deadline; an opening failure rejects construction and cleans up
the process.

Resume retains native history but does **not** retain the previous open's
model/effort or appended instructions in the measured CLI control: omission
uses the CLI defaults. Pass the intended complete configuration again.
There is no `resumedSessionOptions` declaration for this runtime.

```ts
const options = { cwd, model: "gemini-3.8-flash", effort: "low", appendSystemPrompt: instructions };
const first = await antigravityRuntime.session(installation, options);
// After disposing first:
const resumed = await antigravityRuntime.session(installation, { ...options, resume: first.id });
```

The native resume ignores a different supplied `cwd` and keeps the saved
working directory. OAR reads native session listing before resuming and
refuses a different directory with `UnsupportedOptionError("cwd", ...)`,
before any prompt. If listing cannot establish the saved directory, OAR
cannot promise a changed directory ([resume-cwd contract](resume-cwd.md)).

A missing id returns native JSON-RPC error `-32603` on 1.5.0. That code also
covers other internal errors: OAR emits `SessionNotFoundError` only when a
complete `session/list` independently proved that id absent. Otherwise the
native error remains a transport/opening error. Session inventory is not
exposed as a public query. Concurrent controllers for the same id and
continuing in-flight work across processes remain unverified.

### Prompt, steering, queueing, and abort

`prompt()` accepts once the RPC is sent, or rejects `busy` while an active
turn or queued input owns the next slot. Image-only input goes as ACP image
blocks without an invented text prompt; the native Gemini request preserves
the image. Unsupported audio is not sent.

**Steer is supported.** With the first provider response held, a second
native prompt entered the next model request in the same tool loop, before
its final answer. The CLI answered the *original* prompt early, while that
provider response was still held. OAR therefore marks a steer as
superseding the earlier prompt: the earlier answer is still a frame, but
cannot report `turn_ended` or release the busy gate. The latest prompt's
answer settles the turn. The vendor regression asserts this ordering,
provider input, one completion and rejection of a premature new prompt.

`queue()` holds input in memory (`durable: false`) and sends it FIFO when
active work ends. The dispatch is recorded as a prompt carrying the original
queue submission, so it is one logical input. `withdraw(inputId)` removes an
input before dispatch; it returns `not_queued` afterward. Held inputs are
lost when their owning OAR process exits.

`abort()` sends `session/cancel`. A native prompt answer with
`stopReason: "cancelled"` produces an aborted turn. Other stop reasons map
to completion. The common ACP fallback terminates the owned process when
native cancellation does not settle within ten seconds. The behavior suite
checks cancellation and disposal with the CLI/local provider; the old
service's real-shell cancellation timings are historical evidence, not a
claim about CLI 1.5.0.

### Observation, children, and history

Text and tool updates project through the shared ACP mapping; unrecognized
frames remain available verbatim. Detail strings are bounded at 10,000
characters, while `native` retains the full value. Resume does not replay
history. No CLI child-attribution control or real-account child run has been
performed, so the attribution declaration remains `opaque`.

No `usage_update` or prompt usage was observed in the local CLI controls.
OAR does not fabricate token or context totals. A native `/compact`
available-command entry alone does not prove compaction completion.
The native failure regression still records the observed completed-looking
turn after a rejected provider key, rather than reclassifying agent text as
an error. See the versioned
[failure evidence](../spec/runtime-matrix.md#failure-evidence).

### Models, instructions, and context

`listModels()` initializes ACP and opens a temporary session without a
prompt, reads its model selector, closes it, and terminates the process.
Startup, native configuration and account/catalog network access remain
possible. It is not a local auth-status query.

1.5.0 reports grouped model ids such as `gemini-3.8-flash`, with a separate
`thought_level` config option in category `thought_level`. OAR selects each
through `session/set_config_option` and folds the returned values; an empty
`session/set_model` acknowledgement would not establish model readback.
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

### Process ownership, installation, and account usage

OAR owns the CLI and its session workers, uses native close when available,
and cleans up the owned process tree on disposal. Persisted conversations
are not deleted. Host-exit and descendant limitations are the
[shared process contract](../spec/record-stream.md#the-rules).

Discovery checks `OAR_ANTIGRAVITY_BIN`, PATH `agy`, then the official install
location: `~/.local/bin/agy` on Linux/macOS or
`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows (with the standard user AppData
fallback). The plain `--version` release must be at least 1.5.0. Older CLI
versions can return success and help for an unknown `acp` command, so help's
exit code alone is insufficient. An override pointing at `agy_acp_server`
is refused with a migration instruction.

The [official CLI installer](https://antigravity.google/docs/cli) supplies
`installPlan` and `install` on Linux/macOS:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

The plan names its source, required tools and write locations. The installer
verifies the downloaded release checksum. On Windows OAR returns the
vendor's PowerShell instruction as an unsupported-platform plan; it does
not execute that unverified installer. The Linux isolated-home smoke test
verified a new installation, discovery with the install bin off PATH, and
an idempotent second install.

`checkUpdate` reads the CLI's platform manifest and counts only a newer
release. OAR has no `upgrade` method for this runtime; the native CLI has
`agy update`. Existing CLI auto-update behavior is not disabled by the
product adapter (the test fixture disables it).

For a new login use the vendor's terminal flow, documented as
`agy acp --login`; existing CLI configuration is reused. OAR has not
implemented or verified typed login, auth-status or logout controls for the
CLI, and does not migrate the retired service's credential store. This is
an integration gap, not a claim about current account terms. No real login
was created or changed by this migration's tests.

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

Non-empty `additionalDirectories` remains refused, for a newly measured
reason. CLI 1.5.0 advertises and adds workspace roots, but can select an extra
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

## Orientation query costs

Model listing creates a temporary native session, and can do native
configuration or account/catalog I/O, but submits no prompt. There is no
local auth-status reader or substitute login flow. Installation and model
listing accept the session-style env overlay for discovery and native
queries ([reader environments](../spec/orientation.md#environment)).

## Reader environment

`OAR_ANTIGRAVITY_BIN`, HOME and native config variables in the env overlay
apply to installation and model listing just as to sessions. An overlay
never rewrites the host process environment.

## Verification and open gaps

The [migration report](../../experiments/antigravity-cli-acp-2026-11-05.md)
links repeatable native controls and the runtime-specific vendor tests.
The local behavior suite covers prompt, steer, queue, cancellation, resume,
models, images and disposal as applicable. Antigravity remains outside the
required native CI matrix; unit/fake-transport coverage runs on all CI
platforms. Native Windows/macOS, real-account inference and login, child
attribution, usage, structured compaction and concurrent same-id controllers
remain unverified.

Historical evidence stays versioned: the
[CLI 1.4.9 versus separate ACP 1.4.4 comparison](../../experiments/antigravity-steering-2026-10-29.md),
[separate ACP 1.4.5 checks](../../experiments/runtime-version-checks/2026-10-30.md#antigravity-145),
[tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md),
[additional-directory audit](../../experiments/additional-directories-2026-10-11.md),
[native settings probe](../../experiments/antigravity-native-settings.ts) and
[MCP permissions comparison](../../experiments/runtime-version-checks/2026-10-24.md#settings-persistence-and-tool-list-changes).
Their old service conclusions do not describe the new CLI adapter.
