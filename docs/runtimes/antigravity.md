# Antigravity

Independent inventories: not implemented for Antigravity yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

Evidence baseline: **agy_acp_server 1.2.1** (Google Antigravity's ACP server,
from the ACP registry zip, linux x64, model `gemini-3.8-flash-low`) on
2026-09-29 through
[`experiments/live-contract.ts antigravity`](../../experiments/live-contract.ts)
(12/13, scenario names in parentheses below; `abort` fails, see
[abort](#prompt-steering-queueing-and-abort)), plus direct ACP probes of the
same binary for cancel timing and the model and mode methods. The server
ships as a packaged Python archive without a public source repository;
the 1.3.0 archive includes its ACP Python source, inspected in the
[launch audit](#models-instructions-and-context) below. The registry lists **1.3.0** as of
2026-10-03; on a host without the server's own login, `basic` and
`tool-detail` stopped while opening with the native `Authentication
required`, so the live session behavior below is not established for 1.3.0
([October 3](../../experiments/runtime-version-checks/2026-10-03.md), still
open [October 4](../../experiments/runtime-version-checks/2026-10-04.md)).
Versions are evidence baselines, not a support range; see the
[runtime index](README.md) for status conventions.

## Native concepts and calling interfaces

A native session is a persistent conversation with an id, a working
directory, a permission mode (`default`, `auto_edit`, `yolo`), and a model.
Effort is part of the model id (`gemini-3.8-flash-high`, `-medium`, `-low`),
not a separate parameter. A child agent started through the `start_subagent`
tool has its own id inside the harness but no ACP session of its own.

Antigravity offers three programmatic surfaces: the `agy` CLI's print mode (a
one-shot stream with no control channel while a turn runs), the SDK's local
harness (undocumented), and `agy_acp_server`, a separate package of about
1 GB that speaks ACP JSON-RPC over stdio. Only the ACP server has prompt,
cancel, resume and reverse requests on one connection, so OAR uses it. The
server keeps its own credential store under `$GEMINI_HOME/antigravity-acp/`,
separate from the `agy` CLI's login.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `agy_acp_server` executable | One `agy_acp_server.par --uid=` subprocess per OAR Session on Linux (no args elsewhere), spawned in the session `cwd` with the env overlay; its exit is an `exited` response record. |
| Persistent native session | `Session.id` is the native `sessionId`; `SessionOptions.resume` attaches through `session/resume`, which replays nothing. |
| Handshake answers and opening pushes | Answers are Frame records with `model` events where they report one; pushes are recorded in arrival order, so `Session.model()` is a fold over the stream. No `authenticate` is sent. |
| Native agent and turn | Every `session/update` is one frame with `native` verbatim. No `spanId` (ACP updates carry no turn id). Attribution tier `opaque`: a child's activity arrives under the parent's session id with nothing that identifies it as a child. |
| Prompt, steer, queue and cancel | A turn is one `session/prompt` RPC, its answer carrying `turn_ended`. The session has no `steer`; `queue()` is a host-memory FIFO; `abort()` is `session/cancel` with a kill fallback that a running shell command reaches. |
| Typed events, history and child graph | Events for message, tool and model updates; unknown kinds are recorded with no events. No usage, reasoning, compaction or retry frame arrived. The graph is the root session only. |
| Client execution and interaction duties | Antigravity runs its own tools. In `yolo` no `session/request_permission` arrives; in `default` it precedes every shell call. |

Sources: [Antigravity profile](../../packages/oar/src/runtimes/antigravity/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[event projection](../../packages/oar/src/shared/acp/projection.ts),
[client app](../../packages/oar/src/shared/acp/client-app.ts).

## Capability details

### Session creation and resume

**What the runtime advertises (1.2.1):** `initialize` answers
`protocolVersion: 1`, `loadSession: true`, `sessionCapabilities` with `list`
and `resume` (no `close`), `promptCapabilities` image, audio and
embeddedContext, `mcpCapabilities` http + sse, `agentInfo` `antigravity-acp`
("Google Antigravity", 1.2.1), an `auth` block offering logout, and four auth
methods: `oauth-personal`, `oauth-business` (Gemini Enterprise),
`gemini-api-key` and `agent-platform` (Vertex). `session/new` answers
`sessionId`, `modes` (`default` "Default permission prompt flow", `auto_edit`
"Auto-approve file edit tools", `yolo` "Auto-approve all tools"; current
`default`), `models`, and two `configOptions`: `model` and `mode`. Eleven
model ids were offered on a personal login: `gemini-3.8-flash`,
`gemini-3.7-flash` and `gemini-3.6-flash`, each at `high`, `medium` and
`low`, plus `gemini-pro-agent` ("Gemini 3.1 Pro (High)") and
`gemini-3.1-pro-low`.

**Mapped:** OAR launches `agy_acp_server.par --uid=` on Linux, the ACP
registry's launch line. Without the empty `--uid=` the server drops
privileges to group `nobody` at startup and, on a host without that group,
aborts with `Check failed: LookupGIDByGroupName` before speaking ACP.
Initialize declares `fs` read/write `false`, `terminal: true` and
`clientInfo` `oar`. OAR sends no `authenticate`: the server signs in from the
`auth.type` its own login persisted in
`$GEMINI_HOME/antigravity-acp/settings.json` with the cached token, or from
`GEMINI_API_KEY`; with neither, `session/new` fails with `-32000` and session
construction rejects. OAR passes the session's `mcpServers` (`[]` without
them; see [session MCP servers](#session-mcp-servers)), then selects `yolo` with
`session/set_mode` (answered `{}`) whenever the answer lists it, as a mode or
as a `mode` config value. A requested model goes through
`session/set_config_option {configId: "model"}`: the `session/set_model`
answer is `{}` and no `config_option_update` is ever pushed, so only the
config option answer reports the switch. Every opening request has a 30
second deadline, because a cold start unpacks the Python archive; spawn, auth
and creation failures reject session construction with the process killed.
The opening stream is four records before the first prompt: `initialize`,
`session/new` (model event), `available_commands_update` (`/plan` and
`/logout`), and the `session/set_config_option` answer (model event, e.g.
`gemini-3.8-flash-low`); the `session/set_mode` answer is not a frame. Opening
takes about 8 s (`basic`).

**Resume (mapped):** OAR resumes through
`session/resume { sessionId, cwd, mcpServers }`, which Antigravity answers
without replaying history, so the resumed stream (seq 0) opens with
`initialize`, the `session/resume` answer (model event),
`available_commands_update` and the model switch. The resumed session comes
back in mode `default`, so OAR applies `yolo` again on every open.
`Session.id` is the earlier id, and the next prompt recalls what was taught
before disposal (`resume` scenario: a codeword).

```ts
const resumed = await antigravityRuntime.session(installation, {
  cwd,
  resume: previousSessionId, // Exact earlier Session.id.
});
const next = resumed.prompt("Continue");
```

`session/load` (with replay) is advertised and unused. Unknown ids,
concurrent same-id controllers, and continuing in-flight work across OAR
subprocesses are **unverified**. Native `session/list` is advertised; OAR
does not expose it.

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt(string)` records a prompt request answered
`accepted` once the RPC is on the wire, or `rejected` (`busy` during a turn,
`busy-and-late-control`; `runtime_exited` once the process is gone). The RPC
answer is recorded as frame `session/prompt` with the `turn_ended` event.
`InputOptions.images` go as ACP `image` blocks before the text, since
`initialize` advertises `promptCapabilities.image`; delivery to the local scripted model is verified below. The advertised audio and embedded context support is unused.

For image-only input OAR sends ACP image blocks without a text block.
Antigravity 1.3.0 sends Gemini `inlineData` plus its own nonempty text part
containing a `USER_REQUEST` wrapper and metadata. The
[image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts) confirms image delivery without an empty text block, using a local
scripted provider and a dummy key.

**Steer (not available on this transport):** ACP has no steer method, so
the session has no `steer`; the live `steer` scenario skips on that.
`steerOrQueue()` and `deliver()` therefore queue.

**Queue (mapped):** `queue()` is a host-memory FIFO
(`capabilities.queue.durable: false`), drained one input per turn end; the
drained input runs as a spontaneous turn with its own `session/prompt` answer
and no prompt request of its own (`queue`). Held input is dropped once the
runtime is unreachable. `withdraw(inputId)` takes an input out of the FIFO
before it is prompted (`accepted`) and answers `not_queued` after
([test](../../tests/acp/acp-session-withdraw.test.ts)).

**Abort (mapped, needs process termination with a shell command running):** `abort()` sends
`session/cancel` (a notification, so the `accepted` answer carries no
`native`) and is `rejected no active turn` after the turn. While text is
streaming Antigravity answers the prompt `stopReason: "cancelled"` at once,
recorded as `turn_ended: aborted`. While a shell command runs it does not: in
a direct probe the cancelled prompt was answered only when the command
finished, 40.1 s after the cancel, with the command's output intact. OAR's
fallback kills the process when the cancelled prompt is not answered within
ten seconds, as observed in the live `abort` scenario (a long shell command).
The exit is read as `aborted` because the cancel was accepted; there is no
native `turn_ended` frame. The exit code remains on `exited`, and a later
`abort()` is `rejected runtime_exited`. The session itself
survives the kill and can be resumed. The ten second fallback stays: a longer
one would hold `abort()` hostage to whatever the command does.

**Outcomes:** `turn_ended` maps `cancelled` to aborted and every other stop
reason to completed; the answer itself is the event's `native`. Opening with
an unknown model makes `session/set_config_option` answer an error with the
message `Model '<id>' is not available for the current authentication
method.` and `data {modelId, availableModels}`; session construction rejects
with that error and no OAR session exists (`bad-model`).

**Unreachable runtime:** `close` is not advertised, so `dispose()` mid-turn
runs the cancel path, then the kill; the process exits with `code: null` and
the dispose request is answered by that `exited` response, which also ends
the open turn as `aborted` because dispose was requested (`dispose-mid-turn`). When the
process dies on its own (SIGKILL mid-turn), the stream gets an `exited`
response with `requestId ""` and `code: null`, which is the turn's end; a
later `prompt()` is rejected and a later `dispose()` is answered `accepted`
(`kill-runtime`).

### Observation, children, and history

**Mapped:** every update is a frame with `native` verbatim; events carry text
(`agent_message_chunk` → `text_delta`), tool boundaries and model reports. No
`agent_thought_chunk` arrived in any scenario, so no reasoning events appear.
Detail strings truncate at 10,000 characters (`native` does not).
`Session.usage()` totals and `contextUsage()` stay empty: Antigravity sends no
`usage_update` and no token totals on any answer, so no `cacheRead` or
`cacheWrite` either.

**Known gap: a failed turn looks completed.** Against a scripted Gemini
provider (ACP server 1.3.0, [failure evidence](../spec/runtime-matrix.md#failure-evidence)),
a rejected key, a billing error or an oversized context ends the prompt
`stopReason: end_turn` with no message; a 500 or a model the provider refuses
ends it `end_turn` after the provider's text as agent text; a 429 or 503
sends nothing for at least 150 s. OAR records the first two as `completed`.
Only a missing login (-32000 "Authentication required") and a model it does
not offer (-32602) fail, when the session opens.

**Tool frames:** Antigravity executes tools itself. In `yolo` a shell call
opens with a `tool_call` whose `title` is the command, `kind: "execute"`,
`status: "in_progress"` and `rawInput {command_line, working_dir}`, so
`tool_call_started` carries the command as `input`. A `completed` update
follows with `rawOutput {commandLine, workingDir, exitCode, exit_code,
combinedOutput, formatted_output}`, which becomes `tool_call_ended.content` (one `other` part)
with `result: "ok"` and `exitCode` (`tool-detail`). OAR maps the explicit ACP
`ToolCallStatus` values `completed` / `failed` to `result: "ok"` /
`"failed"`; a non-terminal or missing status leaves `result` absent. The
`toolCallId` is `<sessionId>:<n>`, counting calls within the session. In
`default` mode the same call is first offered through
`session/request_permission` with `status: "pending"` and a bare hex
`toolCallId`.

**Children (opaque):** the model starts a child through the `start_subagent`
tool. The parent's `tool_call` ("Running start_subagent", `kind: "other"`,
`rawInput {}`) completes at once with `rawOutput` "Invoke subagent"; the
child's tool calls then arrive under the parent's session id with
`toolCallId` `<childId>:<n>`, and the child's text is interleaved into the
parent's `agent_message_chunk` stream. Nothing on the wire says a frame
belongs to the child except that `toolCallId` prefix, which is not a
documented link, so OAR keeps everything on the root and adds no graph node or
edge (`subagent`: one node, no edges, about 67 s). No child usage is
reported.

**History:** the retained stream backs `rawEvents(observer, cursor)` for the
life of the process (`cursor`); OAR enumerates no native history.

### Models, instructions, and context

**Mapped:** open-time model selection (`SessionOptions.model` →
`session/set_config_option {configId: "model"}`), read back from the answer's
`configOptions`, never from the request parameter. The server has no model
list method, so `listModels` (and `oar models antigravity`) opens a throwaway
session and reads the options of its `model` config option; the process is
then killed, since there is no `session/close`. No entry carries effort
levels.

**Effort (not a separate setting):** effort is folded into the model id, so
pick `gemini-3.8-flash-high` rather than setting effort. There is no
`thought_level` option; a `session/set_config_option` on one answers
`-32602`. `SessionOptions.effort` is not mapped: OAR refuses the open with an
`UnsupportedOptionError` on `effort` because no `thought_level` option is
advertised, and no `effort` event appears
([ACP effort channel](../../packages/oar/src/shared/acp/effort.ts)).

`session()` refuses `systemPrompt` and `appendSystemPrompt` with an
`UnsupportedOptionError`, declared before open in
`antigravityRuntime.refusedSessionOptions`, because the selected server has
no instruction input through its protocol, launch options or configuration
([refused session options](../spec/runtime-matrix.md#refused-session-options)).

**Native launch audit (1.3.0, 2026-10-07).** The
[official Linux distribution](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip)
contains `agy_acp_server.par`, readable as a ZIP archive. Under
`google3/cloud/developer_experience/antigravity_extensions/acp_server/`:

- `main.py`, consistent with `--help` and `--helpfull`, defines only `debug`
  and `notices` as application flags; the remaining flags are library flags.
- `settings.py` accepts only `auth` and `gcp` sections and warns on unknown
  keys. `server.py` builds the harness configuration without a system-prompt
  or append input. No supported per-session instruction channel was found.
- `model_selection.py` reads `AGY_ACP_DEFAULT_MODEL`, but thinking levels are
  associated with model ids; `server.py` translates that metadata into the
  model endpoint's thinking setting. This supplies no independent effort
  input. OAR keeps the existing ACP model selection and readback.

| Session option | Channel used by OAR |
| --- | --- |
| `cwd` | ACP session creation or resume, and the subprocess working directory. |
| `resume` | ACP `session/resume`, or `session/load` when resume is not advertised. |
| `model` | ACP `session/set_config_option` on `model`, with readback. |
| `effort` | Refused when no `thought_level` is advertised; choose a native model variant instead. |
| `env` | Environment of this session's subprocess and tool subprocesses; `null` removes an inherited variable ([contract](../spec/runtime-matrix.md#session-environment)). |
| `mcpServers` | ACP `mcpServers` on `session/new`, `session/resume` and `session/load` ([session MCP servers](#session-mcp-servers)). |
| `systemPrompt`, `appendSystemPrompt` | Refused: no prompt input in the selected server's protocol, launcher or configuration. |

This is a help and distributed-source audit, separate from the 1.2.1 live
probes above. It does not resolve the 1.3.0 authentication gap or establish
new steer, usage or child-attribution behavior. OAR does not change
`GEMINI_HOME`, write user settings or use the private SDK to fill these gaps.

**Context (unexposed by the runtime):** no frame carries context occupancy,
so `contextUsage()` stays empty. Antigravity advertises no compaction through
ACP.

### Tools, permissions, and extensions

Antigravity runs shell, file and search tools itself: no `terminal/*` or `fs/*`
request arrived in any scenario, so OAR's terminal host is never called. OAR
passes the session's own MCP servers ([below](#session-mcp-servers));
vendor-configured tools can still run.

In `yolo` no `session/request_permission` arrived in any scenario. If a
session cannot be put in `yolo` (the mode is missing from the answer), the
agent asks through `session/request_permission`, which OAR answers with
`allow_always`, then `allow_once`, otherwise `cancelled`; in a direct probe in
`default` mode the request offered allow-once options and the call ran after
the answer. That path is **unverified** through OAR.

### Session MCP servers

`SessionOptions.mcpServers` is ACP's `mcpServers` on `session/new`,
`session/resume` and `session/load`, in ACP's `McpServer` shape (stdio
`{name, command, args, env}`, http `{type: "http", name, url, headers}`,
`env` and `headers` as `{name, value}` lists; `args`, `env` and `headers`
always sent;
[mapping](../../packages/oar/src/shared/acp/mcp-servers.ts),
[test](../../tests/acp/acp-session-mcp-servers.test.ts)). An empty or
repeated name fails the open before the server starts. The 1.3.0 source in
the `.par` declares `mcpCapabilities` http and sse (`server.py:2537`), so
http entries are sent, and passes the list from `session/new` (`:3258`),
`session/resume` (`:3674`) and `session/load` (`:3765`) into
`_create_agent_config` (`:3804`): servers are per session.
`mcp_servers.py:16-55` converts `env` and `headers` to maps and an sse entry
to streamable HTTP. Measured on agy_acp_server 1.3.0 (1.2.1 not run) against
a scripted provider: fresh `HOME` and `GEMINI_HOME`, `{auth: {type:
"gemini-api-key"}}` in `$GEMINI_HOME/antigravity-acp/settings.json` plus a
dummy `GEMINI_API_KEY` (on 1.3.0 the variable alone selects no auth method),
and the model harness `localharness_external` beside the `.par` sending
`streamGenerateContent` to `GOOGLE_GEMINI_BASE_URL`
([vendor test](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts),
[harness](../../sea-trial/harness/aimock-acp.ts); `OAR_ANTIGRAVITY_BIN`
names that `.par`):

- Servers start lazily: nothing is spawned at `session/new` or
  `session/resume`; the first prompt spawns them, initializes them and lists
  their tools, and they live until the agent process exits. A broken server
  shows only as an error during a prompt (`server.py:5247`).
- A lazily loaded server is listed in a `<mcp_servers>` block of the system
  prompt, and the model calls its tools through `call_mcp_tool {ServerName,
  ToolName, Arguments, toolSummary, toolAction}` (an eager server's tools
  would be `mcp_<server>_<tool>`); the ACP `tool_call` title is `Running
  echo`. The tool result reached the provider as the server wrote it (with
  no credential: see below). The harness sends tool
  results under role `model`; the test proxy hands them to aimock as role
  `user` (`geminiToolResultsAsUser` in
  [raw-capture](../../sea-trial/harness/raw-capture.ts)).
- A resume remembers none: given again, the servers attach; probed, resumed
  with none, nothing is listed and a call answers `unknown tool name:
  call_mcp_tool`.
- On a name clash the session's entry replaces the user's of the same name
  in `$GEMINI_HOME/config/mcp_config.json` (read at `mcp_servers.py:120-129`,
  replaced at `:132-149`; measured: the session's server answered). The
  user's non-clashing server still attaches; a probe found the user config
  unchanged.

**Entries carrying credentials are refused.** Antigravity stores a session's
`mcpServers`, `env` and header values included, in plain text in its
conversation database `$GEMINI_HOME/antigravity-acp/conversations/<sessionId>.db`
(mode 0600; measured: a stdio entry's `env` token in the `-wal` file). The
file outlives the session, a resume does not reuse what it stored, and a
host can neither see nor clear it through ACP, while credentials may reach a
runtime only through its native channel, never its disk. So an entry with a
non-empty `env` or `headers` fails the open with an `UnsupportedOptionError`
on `mcpServers` before the server starts
([`refuseAntigravityMcpCredentials`](../../packages/oar/src/runtimes/antigravity/session.ts));
an entry without them attaches as above (the vendor test's servers carry
none, and it checks the refusal). A server that needs a secret has to get it
some other way than the entry, for example from a file it reads itself. No
ACP answer, notification or stderr line carried an entry's values
(measured and probed), and a failed open's error is redacted
(`[redacted]`).

### Process ownership, installation, and account usage

**Mapped:** OAR owns the spawned process. Disposal cancels active work, kills
the process (no `session/close` is advertised), and disposes hosted
terminals; a dispose after an observed exit is answered `accepted` without
further work. On POSIX the process leads its own process group, and a runtime
still running a grace period after SIGTERM (10 s, or `OAR_KILL_GRACE_MS`) is
SIGKILLed with its group. That SIGKILL, or the runtime's exit if that comes
first, also takes its descendants that left its group (as for
[claude](claude.md#process-ownership-environment-installation-and-account-usage)).
Persisted native sessions are not deleted.

On Windows, the shared ACP session uses `taskkill /T /F` for disposal and
the abort fallback, including the runtime's descendants
([test](../../tests/session-dispose.test.ts)). See
[host-exit cleanup and limits](../spec/record-stream.md#the-rules).

[Installation detection](../../packages/oar/src/runtimes/antigravity/installation.ts)
checks `OAR_ANTIGRAVITY_BIN` and PATH `agy_acp_server.par`
(`agy_acp_server.exe` on Windows), reading `Build label: <version>` from
`--version` with a 30 second timeout. The ACP registry ships a zip with no
installer, so there is no fallback path: put the binary on PATH or name it in
`OAR_ANTIGRAVITY_BIN`. `checkUpdate` compares the installed version with that
registry entry, the only release listing (it can trail Google's downloads),
and counts only a newer registry version as an update; the server has no
updater, so there is no `upgrade` ([runtime updates](update.md)).

**Account terms (caveat):** the vendor FAQ warns that using a personal Google
account from third-party tools may violate the terms of service and can lead
to account suspension, and recommends an API key or Vertex instead. The
evidence above was gathered on a personal login. For anything beyond
evaluation, sign the server in with `gemini-api-key` or `agent-platform`.
For the same reason the runtime has no `login`
([runtime login](../spec/login.md)): OAR does not sign a person's account
in on their behalf, since the terms do not allow it; configure the server
with an API key (`gemini-api-key`) or Vertex (`agent-platform`) instead. The
ACP server's own sign-in also redirects only to a loopback listener with no
code to paste back, so a person on another device could not finish it.
There is no `authStatus`.

Account usage is **unexposed**: OAR has no Antigravity account usage query.

## Verification and open gaps

[`experiments/live-contract.ts antigravity`](../../experiments/live-contract.ts)
covers the promises above on a real login: `basic`, `multi-turn`,
`tool-detail`, `busy-and-late-control`, `steer` (now skipped: the session has
no `steer`), `queue`, `abort` (fails, see above), `dispose-mid-turn`,
`cursor`, `resume`, `subagent`, `kill-runtime`, `bad-model`.
[Antigravity tests](../../tests/acp/acp-session-antigravity.test.ts) use a
fake executable for the missing `authenticate`, `yolo` on new and resumed
sessions, dispose without `session/close`, the model switch readback and
refused effort, a turn that ends with no usage report, the Linux-only
`--uid=`, and the system prompt refusal. The
[real-runtime CI matrix](../../.github/workflows/ci.yml) excludes
Antigravity.

Open gaps: cancelling a running shell command (the vendor waits for the
command; OAR kills after ten seconds); child attribution (the transport
carries none); any usage or context report; the permission path through OAR;
`session/list` and `session/load`; unknown resume ids; a resume naming another
directory ([not measured](resume-cwd.md)); concurrent same-id controllers;
macOS and Windows installation; any authenticated run on 1.3.0;
[session MCP servers](#session-mcp-servers) on a real login and model and on
1.2.1 (measured on 1.3.0 against a scripted provider only; their vendor test
runs locally, `OAR_TEST=antigravity-aimock`, not in CI); whether a later
server stops storing the entries' values, until which entries with `env` or
`headers` are refused. Keep native
API capabilities, transport limitations, OAR omissions and unexecuted checks
separate when designing or claiming support.

## Disallowed tools

`SessionOptions.disallowedTools` goes to `_meta.agy.disabledTools` on
session creation and resume. Only the canonical `BuiltinTools` values from
agy_acp_server 1.3.0's native filter are accepted: `list_directory`,
`search_directory`, `find_file`, `view_file`, `create_file`, `edit_file`,
`run_command`, `ask_question`, `start_subagent`, `generate_image`,
`search_web`, `read_url_content`, `schedule`, `finish`. These are filter
identifiers: for example, the harness offers creation as `write_to_file`
and editing as `replace_file_content`. The native filter performs that
mapping; OAR sends no allowlist.

MCP names, `client_*` file tools and unknown names are refused before
launch with `UnsupportedOptionError`, listing all offending entries. The
native parser would merely log and ignore unknown names. OAR advertises
no client filesystem capability, so those callbacks are absent. A mixed
list fails as a whole. Antigravity persists its filter: omission on resume
restores it, while an explicit empty list clears it.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go after OAR's own arguments to the ACP server. OAR passes them unchecked and never records them; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).
