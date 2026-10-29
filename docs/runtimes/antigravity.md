# Antigravity

Independent inventories: not implemented for Antigravity yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

Evidence baseline: **agy_acp_server 1.2.1** (Google Antigravity's ACP server,
from the ACP registry zip, linux x64, model `gemini-3.8-flash-low`) on
2026-09-29 through
[`experiments/live-contract.ts antigravity`](../../experiments/live-contract.ts)
(12/13, scenario names in parentheses below; `abort` fails, see
[abort](#prompt-steering-queueing-and-abort)), plus direct ACP probes of the
same binary for cancel timing and the model and mode methods. The
personal-login scenarios below remain this 1.2.1 evidence.

Current check: **1.4.4** (2026-10-29), with its matching companion
`localharness_external`, passed nine native tests and all 15 applicable
shared cases against a local scripted Gemini provider. Temporary homes and
dummy keys covered instruction/effort settings, MCP, tool denials,
image-only input and failure reporting. The native settings probe still
finds MCP credentials in `0644` database and WAL files under umask `0022`.
Concurrent prompts still expose the stream-consumer race documented in the
[steering investigation](../../experiments/antigravity-steering-2026-10-29.md);
OAR keeps its queue and absent steer member. See the
[October 29 report](../../experiments/runtime-version-checks/2026-10-29.md#antigravity-144).
These checks do not extend the personal-login evidence.

The server ships as a packaged Python archive without a public source
repository; the 1.4.0 archive includes its ACP Python source. The adapter
uses the 1.4.0 metadata namespace: upgrade the server and companion harness
together. Versions are evidence baselines, not a support range; see the
[runtime index](README.md) for status conventions.

## Native concepts and calling interfaces

A native session is a persistent conversation with an id, a working
directory, a permission mode (`default`, `auto_edit`, `yolo`), and a model.
The 1.4.0 model picker groups thinking variants into model families such as
`gemini-3.8-flash`, with a separate `thinking_level` selector in ACP
category `thought_level`. The native session still holds a concrete variant
such as `gemini-3.8-flash-high`. A child agent started through the `start_subagent`
tool has its own id inside the harness but no ACP session of its own.

Both the `agy` CLI and the separate ACP service are vendor-native entry
points. The CLI now has a documented persistent `stream-json` input mode;
the earlier one-shot print-mode description is no longer complete. OAR keeps
ACP because it exposes the session controls needed by a host on one stdio
connection. The bundled Python SDK drives its companion harness underneath
ACP; OAR does not call that private connection directly.

### CLI versus ACP, checked October 29

The comparison uses **agy CLI 1.4.9** and **ACP 1.4.4** on Linux x64.
`[obs]` is the local-provider probe, `[src]` is the packaged implementation,
and `[doc]` is the vendor's public documentation. Account-specific evidence
elsewhere on this page retains its original version. Details, source paths,
request ordering and the internal-interface boundary are in the
[steering report](../../experiments/antigravity-steering-2026-10-29.md).

| Host need | agy stream-json | ACP service |
| --- | --- | --- |
| Multiple turns | [obs] One process and conversation id, two successful results. Busy input waits for the first answer. | [obs] Repeated `session/prompt`; serialize them to avoid the race below. |
| Mid-turn input | [obs] No injection in stream-json. The interactive UI's `send-immediately` setting does inject before the active tool loop ends. | [src/obs] No exposed steering path; concurrent prompts wait, then race over the shared stream. |
| Cancel | [doc] Process SIGINT; no JSON cancel request. | [src] `session/cancel`; the older real-shell timing limitation below still applies. |
| Resume | [doc] `--conversation` or `--continue`. | [src] `session/resume`, `session/load` and native listing. |
| Model and effort readback | [doc/obs] Launch flags; init reports an explicit model override, not a live model/effort query. | [src] Model and `thinking_level` config options report native choices and current selection. |
| MCP | [doc] Global/project configuration; stdio and streamable HTTP. | [src] Session MCP configuration; native stdio, HTTP and SSE handling. |
| Permission decisions | [doc/obs] Headless policy decisions; control envelopes fail with exit 2. | [src] Reverse `session/request_permission` plus permission mode controls. |
| Usage | [obs] Result has usage and cumulative turn count; this dummy provider reports zero tokens. | [src] 1.4.4 emits `usage_update` and prompt usage; old 1.2.1 observations of absent usage do not describe this source. |
| Linux x64 download / installed payload | [obs] 63.29 MiB tarball / 219.07 MiB executable. | [obs] 321.24 MiB zip / 1012.48 MiB archive plus companion, before Python extraction caches. |
| Updates | [doc/src] Official installer and auto-updater manifest. | [src] Registry versioned archive; update server and companion together. |

References: [headless interface](https://antigravity.google/docs/cli/headless/),
[CLI settings](https://antigravity.google/docs/settings?tab=cli),
[CLI MCP](https://antigravity.google/docs/mcp?tab=cli),
[installer](https://antigravity.google/cli/install.sh), and the
[ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).

**Decision:** continue using ACP. The CLI adds persistent sequential input,
but its public stream does not replace ACP's cancel, permission response and
configuration controls. The UI's internal `SendUserCascadeMessage` RPC is
not an OAR integration surface. Daily checks should report a newly public
immediate-send or control-request interface in either product before
reconsidering this choice.

The
server keeps its own credential store under `$GEMINI_HOME/antigravity-acp/`,
separate from the `agy` CLI's login. Its file tools are confined to the
session's `cwd` and the skills directories, but its own `view_file` also
allows all of `$GEMINI_HOME`, the directory that holds that credential store,
so the agent can read the stored login (agy_acp_server 1.3.0 source:
`server.py:3873-3890`, `acp/tools.py:72-142`). Give a session its own
`GEMINI_HOME` in `SessionOptions.env` when the agent should not see your
login.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `agy_acp_server` executable | One `agy_acp_server.par --uid=` subprocess per OAR Session on Linux (no args elsewhere), spawned in the session `cwd` with the env overlay; its exit is an `exited` response record. |
| Persistent native session | `Session.id` is the native `sessionId`; `SessionOptions.resume` attaches through `session/resume`, which replays nothing. |
| Handshake answers and opening pushes | Answers are Frame records with `model` and `effort` events where they report them; pushes are recorded in arrival order, so queries fold the stream. No `authenticate` is sent. |
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
`gemini-3.1-pro-low` (1.4.0 groups such variants into families; see
[models](#models-instructions-and-context)).

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
The 1.2.1 opening stream was four records before the first prompt: `initialize`,
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

A resume/load error `-32002` becomes `SessionNotFoundError` with the requested
`sessionId` and method/native error in `cause`. On 1.3.0 it means missing
under the active `GEMINI_HOME`, and the native data names the expected file
([missing targets](../spec/runtime-matrix.md#missing-resume-targets)).

`session/load` (with replay) is advertised and unused when resume is available.
Concurrent same-id controllers, and continuing in-flight work across OAR
subprocesses are **unverified**. Native `session/list` is advertised; OAR
does not expose it. `SessionOptions.name` is declared refused: there is no
verified session name setting ([session name](../spec/runtime-matrix.md#session-name)).

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
[image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts)
confirms image delivery without an empty text block, using a local scripted
provider and a dummy key (passing on 1.4.1).

**Steer (no native route found in ACP server 1.4.4):** the October 29 source
review and [busy-prompt probe](../../experiments/antigravity-steering-2026-10-29.md)
checked the packaged ACP server, its private metadata and its bundled SDK.
`server.py:5580-5711` passes each prompt to `agent.chat()` without reading
prompt metadata. `google/antigravity/conversation/conversation.py:93-120`
waits for an active conversation to become idle before sending another
message. The adapter has no extension handler exposing the SDK's lower-level
trigger notification. This is a checked transport limitation, not an inference
from the standard ACP method list alone.

With the first provider response held, three concurrent-prompt trials all
kept the second input out of the first tool loop. It reached the model only
after the first final answer. All three also exposed a native concurrency bug:
the second RPC returned `end_turn` before its model request, an agent message
reported concurrent `receive_steps()` calls, and the first RPC stayed open
through the second answer. A sequential control delivered two separate turns
without that error. The [report](../../experiments/antigravity-steering-2026-10-29.md)
records the source chain, timings and repeat measurements; these use a local
scripted provider, not a personal login.

OAR therefore exposes no `steer` and does not send concurrent prompts on this
transport. `steerOrQueue()` and default `deliver()` use the host queue; an
explicit interrupt delivery keeps its separate abort-and-prompt meaning.
Re-run the steering probe when upgrading Antigravity. The CLI UI result is
separate: three `send-immediately` trials put new input into the next model
request before the first final answer, whereas UI queue mode and stream-json
waited for that answer. This does not supply an ACP or public stream control.

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
No `usage_update` and no token totals arrived on any answer (1.2.1 live,
1.4.0 scripted), so `Session.usage()` totals and `contextUsage()` stay empty,
with no `cacheRead` or `cacheWrite` either. The 1.4.0 source can emit
`usage_update` when token usage and a context size are available; no
observed turn reached that.

**Known gap: a failed turn looks completed.** Against a scripted Gemini
provider (ACP server 1.3.0, [failure evidence](../spec/runtime-matrix.md#failure-evidence)),
a rejected key, a billing error or an oversized context ends the prompt
`stopReason: end_turn` with no message; a 500 or a model the provider refuses
ends it `end_turn` after the provider's text as agent text; a 429 or 503
sends nothing for at least 150 s. OAR records the first two as `completed`
(the rejected key again on 1.4.1).
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

### Service tiers

`SessionOptions.serviceTier` is explicitly refused with
`UnsupportedOptionError`, declared in `Runtime.refusedSessionOptions`.
No per-session native setting plus applied-state readback has been verified
for this adapter; `listModels` therefore advertises no service tiers. OAR
does not silently ignore a requested tier or alter a global default.

### Models, instructions, and context

**Models (1.4.0 and 1.4.1):** `SessionOptions.model` goes to
`session/set_config_option {configId: "model"}`. OAR reads the answer's
`configOptions`, never the request parameter. The server has no model-list
method, so `listModels` opens a throwaway session, reads its `model` option,
and kills the process (no `session/close`). Native family ids replace the
former per-effort entries: the scripted API-key configuration lists five
families, including `gemini-3.8-flash` and `gemini-3.1-pro`. Other account
and gateway configurations may offer different lists. OAR follows the
native picker and does not parse suffixes to invent families or levels.
`Session.model()` likewise reports the family selector, not the concrete
variant in the separate legacy `models.currentModelId` field.

**Effort:** `SessionOptions.effort` uses the `thought_level` config option,
whose native id is `thinking_level`, after any model selection. The reply
must report the requested level; a missing selector or a refused/different
value fails the open. `Session.effort()` folds that native report. A fresh
session advertises levels only for its current model, so `listModels`
attaches `effortLevels` and `defaultEffort` only to that entry. It does not
infer the other entries' menus. For `gemini-3.8-flash`, the measured menu is
`low`, `medium`, `high`, with `high` selected initially. New `low` and resumed
`high` both reached the provider's `generationConfig.thinkingConfig`.
Omitting effort on resume selected the runtime's `high` default after a
previous `low` turn; pass it again when that choice matters.

**Instructions:** `appendSystemPrompt` goes on new, load and resume as
`_meta.antigravity.systemPrompt.append`, provided `initialize` advertises
`agentCapabilities._meta.antigravity.systemPrompt.append: true`. Otherwise
OAR throws `UnsupportedOptionError` before opening. The runtime appends it
to its built-in harness instructions; the provider request carries both.
The runtime trims surrounding whitespace and ignores an empty append.
OAR sends the supplied value unchanged. A resume uses the new append;
omitting it removes the prior append from the next request's system
instructions. OAR does not rewrite the saved conversation. `systemPrompt`
replacement remains refused and declared in `refusedSessionOptions`.

| Session option | Channel used by OAR |
| --- | --- |
| `cwd` | ACP session creation or resume, and the subprocess working directory. |
| `resume` | ACP `session/resume`, or `session/load` when resume is not advertised. |
| `model` | ACP `session/set_config_option` on `model`, with readback. |
| `effort` | The advertised `thought_level` selector, with strict readback. |
| `env` | Environment of this session's subprocess and tool subprocesses; `null` removes an inherited variable ([contract](../spec/runtime-matrix.md#session-environment)). |
| `mcpServers` | ACP `mcpServers` on `session/new`, `session/resume` and `session/load` ([session MCP servers](#session-mcp-servers)). |
| `appendSystemPrompt` | `_meta.antigravity.systemPrompt.append`, on every open. |
| `systemPrompt` | Refused: no native replacement input. |

The [official 1.4.0 distribution](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip)
contains the ACP sources `config_options.py`, `system_prompt.py`,
`request_meta.py` and `server.py`. Their model grouping, append capability,
and new/resume mapping agree with the native probe. Settings and model
requests use only ACP; OAR does not edit user settings or invoke the private
harness SDK. Gateway and OAuth-specific grouping were source-audited, not
executed with real accounts; the 1.4.1 source also changes Agent Platform's
default to Gemini 4 Argon, filters disabled OAuth models and extends effort
variants beyond Gemini families
([October 18](../../experiments/runtime-version-checks/2026-10-18.md#antigravity-141)).
Native compaction with an append was not tested.

**Context:** no observed frame carries context occupancy (see
[observation](#observation-children-and-history)). The `/usage` command
(new in 1.4.0) produces native message text; OAR does not parse it into account usage.
Account-plan metadata named `tier` is not a session service-tier setting.
Antigravity advertises no compaction through ACP.

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
to streamable HTTP. Measured on agy_acp_server 1.3.0 (1.2.1 not run; the
vendor test also passes on 1.4.3 after updating its native title expectation)
against a scripted provider: fresh `HOME` and `GEMINI_HOME`, `{auth: {type:
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
  would be `mcp_<server>_<tool>`). On 1.4.3 the ACP `tool_call` title is
  `<server>_<tool>` (`echo_echo` and `remote_echo` in the test); the 1.4.1
  control still reports `Running echo`. 1.4.3 also includes `_meta.mcp`
  with server/tool names and `is_mcp_tool_call: true`; `rawInput` contains
  both an `arguments` object and its top-level fields. OAR retains this
  native frame and projects the opening title as the tool name. The tool
  result reached the provider as the server wrote it (with
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
- A tool-list change reaches the next model request: after the server's
  `notifications/tools/list_changed` the client lists again, the system
  instruction's MCP catalog holds only the new set, and a call to a removed
  tool runs no handler (`mcpToolsListChanged: "full"`, rechecked on 1.4.3;
  [contract](../spec/runtime-matrix.md#host-served-tools),
  [October 24](../../experiments/runtime-version-checks/2026-10-24.md#settings-persistence-and-tool-list-changes)).

**Entries carrying credentials are refused.** Antigravity stores a session's
`mcpServers`, `env` and header values included, in plain text in its
conversation database `$GEMINI_HOME/antigravity-acp/conversations/<sessionId>.db`
and its `-wal` file, where they remain after process disposal (measured on
1.3.0: a stdio entry's `env` token in the `-wal` file; on 1.4.0, 1.4.1 and 1.4.3:
harmless env and header sentinels in both, through direct native ACP in the
[native settings probe](../../experiments/antigravity-native-settings.ts),
which works in a temporary home and removes it afterward). The files' modes
follow the inherited umask, not a runtime guarantee: on 1.4.1 and 1.4.3,
umask `0022` gave `0644` and `0077` gave `0600`, and a 1.4.0 control under `0022` also
gave `0644`, so the `0600` seen on 1.4.0 (2026-10-14) does not show a
permission the runtime enforces. The probe reports the umask and home mode with each file mode
([latest permissions comparison](../../experiments/runtime-version-checks/2026-10-24.md#settings-persistence-and-tool-list-changes)).
The file outlives the session, a resume does not reuse what it stored, and a
host can neither see nor clear it through ACP, while credentials may reach a
runtime only through its native channel, never its disk. So an entry with a
non-empty `env` or `headers` fails the open with an `UnsupportedOptionError`
on `mcpServers` before the server starts. The refusal is declared as
`refusedSessionOptions.mcpServerCredentials`
([`antigravityRefusedSessionOptions`](../../packages/oar/src/runtimes/antigravity/options.ts),
[#392](https://github.com/botiverse/oar/issues/392)), so a host knows before
opening that tools it serves with `serveMcpTools`, whose entry always
carries a bearer token, will not attach. An entry without them attaches as
above (the vendor test's servers carry none, and it checks the refusal). A
server that needs a secret has to get it some other way than the entry, for
example from a file it reads itself. No ACP answer, notification or stderr
line carried an entry's values (measured and probed), and a failed open's
error is redacted (`[redacted]`).

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
`OAR_ANTIGRAVITY_BIN`. Google documents installing the agent only from an
editor's agent registry
([Zed](https://antigravity.google/docs/ide/extensions/zed): External
Agents, Install from Registry), so `installPlan` and `install` answer
`unsupported` `requires_gui` ([runtime install](../spec/install.md)). `checkUpdate` compares the installed version with that
registry entry, the only release listing (it can trail Google's downloads),
and counts only a newer registry version as an update; the server has no
updater, so there is no `upgrade` ([runtime updates](update.md)).

**Account terms (caveat):** the vendor FAQ warns that using a personal Google
account from third-party tools may violate the terms of service and can lead
to account suspension, and recommends an API key or Vertex instead. The live
evidence above was gathered on a personal login. For anything beyond
evaluation, configure the server with an API key (`gemini-api-key`) or
Vertex (`agent-platform`). For the same reason the runtime has no `login`
([runtime login](../spec/login.md)): OAR does not sign a person's account
in on their behalf, since the terms do not allow it. The ACP server's own
sign-in also redirects only to a loopback listener with no code to paste
back, so a person on another device could not finish it. There is no
`authStatus`.

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
applied effort on creation and resume, a turn that ends with no usage
report, the Linux-only `--uid=`, and the system prompt refusal. The
[real-runtime CI matrix](../../.github/workflows/ci.yml) excludes
Antigravity.

Open gaps: cancelling a running shell command (the vendor waits for the
command; OAR kills after ten seconds); child attribution (the transport
carries none); any usage or context report; the permission path through OAR;
`session/list` and `session/load`; unknown resume ids; a resume naming another
directory ([not measured](resume-cwd.md)); concurrent same-id controllers;
macOS and Windows installation; real-account runs on any version after
1.2.1; [session MCP servers](#session-mcp-servers) on a real login and model
and on 1.2.1 (measured on 1.3.0, 1.4.0 and 1.4.1 against a scripted
provider; their vendor test runs locally, `OAR_TEST=antigravity-aimock`, not
in CI); whether a later server stops storing the entries' values (1.4.1
still does), until which entries with `env` or `headers` are refused. Keep
native API capabilities, transport limitations, OAR omissions and unexecuted
checks separate when designing or claiming support.

## Disallowed tools

`SessionOptions.disallowedTools` goes to `_meta.antigravity.disabledTools` on
session creation and resume. Only the canonical `BuiltinTools` values from
agy_acp_server 1.3.0's native filter are accepted: `list_directory`,
`search_directory`, `find_file`, `view_file`, `create_file`, `edit_file`,
`run_command`, `ask_question`, `start_subagent`, `generate_image`,
`search_web`, `read_url_content`, `schedule`, `finish`. These are filter
identifiers: for example, the harness offers creation as `write_to_file`
and editing as `replace_file_content`. The native filter performs that
mapping; OAR sends no allowlist.

For a non-empty list, `initialize` must advertise
`agentCapabilities._meta.antigravity`; otherwise OAR rejects the open with
`UnsupportedOptionError("disallowedTools", ...)` before creating or resuming
the session. That capability needs server and harness 1.4.0 or newer; the
1.3.0 parser only reads `_meta.agy`: a direct native probe confirmed that
the new namespace opens successfully but leaves the denied tools available.
OAR does not fall back to the old namespace. The
[namespace probe](../../experiments/antigravity-tool-filter-meta.ts)
compares both against a scripted provider without calling any tools.

MCP names, `client_*` file tools and unknown names are refused before
launch with `UnsupportedOptionError`, listing all offending entries. The
native parser would merely log and ignore unknown names. OAR advertises
no client filesystem capability, so those callbacks are absent. A mixed
list fails as a whole. Antigravity persists its filter: omission on resume
restores it, while an explicit empty list clears it (denial and persisted
filter pass the native tests on 1.4.1).

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go after OAR's own arguments to the ACP server. OAR passes them unchecked and never records them; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).

## Additional directories

A non-empty `SessionOptions.additionalDirectories` is declared refused and
fails before launch. Server 1.3.0 advertises no ACP additional-directory
capability. Its new-session signature accepts the field, but the harness
workspace list is built from cwd and skill directories, ignoring that input.
OAR rejects rather than silently discarding it.

[Evidence and verification limits](../../experiments/additional-directories-2026-10-11.md).

## Structured output

`SessionOptions.outputSchema` is declared refused and fails before launch.
The selected ACP server has no verified final-answer schema input in its
protocol, launch arguments or configuration. Tool input schemas are unrelated.

[Native channel audit](../../experiments/structured-output-2026-10-11.md).

## User configuration

`userConfiguration: "exclude"` is declared refused with
`UnsupportedOptionError` before opening a session. This adapter has no
verified separation of user configuration from native login and session
history. Omission and `"include"` retain existing behavior. See the
[shared contract](../spec/runtime-matrix.md#user-configuration).

## Orientation query costs

`listModels()` starts the native ACP server, initializes it, and opens a
temporary native session to obtain the model config option. It closes the
process without submitting a prompt. Native startup, workspace configuration
and account/catalog network I/O remain possible. OAR has no local auth-status
reader and never substitutes a login flow for this query.

## Reader environment

Installation and model listing accept the session-style `env` overlay for
discovery, version checks and the native ACP query. See
[reader environments](../spec/orientation.md#environment).
