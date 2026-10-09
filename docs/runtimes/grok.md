# Grok runtime

Independent inventories (2026-09-16): inspect --json skills and configured/compatibility MCP entries. Independent tools queries are unsupported; no ACP session is created.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

Evidence baseline: native source
[`grok-build` `bc7f02e`](https://github.com/xai-org/grok-build/tree/bc7f02e)
(Grok 1.0.12); the [wire snapshot](../../tests/replay/fixtures/grok-acp-v1.vendor.json)
is Grok 1.0.5 (`5115b46bc9`, 2026-08-26), the binary the
[adapter experiment](../../experiments/acp-runtime.ts) ran on (2026-08-27).
Live observations come from **grok 1.0.25 (`f7e67d6988e2`)**, darwin arm64,
runtime default model, 2026-09-11, through
[`experiments/live-contract.ts grok`](../../experiments/live-contract.ts)
(scenarios cited as `live-contract/<id>`) and the raw
[`experiments/grok-wire-tap.ts`](../../experiments/grok-wire-tap.ts) below the
SDK ([experiments index](../../experiments/README.md)); facts from later
binaries name their version. Versions are evidence baselines, not a support
range; source-supported claims are not a live check of a newer binary. The
[spec](../spec/README.md) is not current OAR behavior. See the
[runtime index](README.md) for evidence and status conventions.

The [October 9 daily check](../../experiments/runtime-version-checks/2026-10-09.md)
passed conversation, tool detail and resume on **1.0.50** (Linux x64,
`grok-4.7`). Its local-provider prompt probe also confirmed that the
replacement/append precedence and append-only resume refusal below remain
necessary. This is focused validation, not a repeat of the full live battery.

## Native concepts and calling interfaces

Grok is a coding-agent harness. Its process owns sessions; each session owns
model context, configuration, incoming prompts, tool execution, and persistent
state. The ACP update log, model chat history, metadata, rewind points, and
compaction checkpoints serve different purposes
([native session description](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/README.md#session-persistence)).

The interactive TUI, headless `grok -p`, and `grok agent stdio` are calling
modes for that harness. OAR uses the last: ACP JSON-RPC over stdio, including
vendor extensions. ACP is bidirectional: Grok can ask its client to execute a
terminal command or decide a permission request while a prompt is running.

A native session ID identifies conversation continuity; a `promptId`, native
turn number, and JSON-RPC request ID have separate roles. Ordinary prompts
enter a delivery queue; `_meta.sendNow` selects immediate dispatch. Subagents
are independent child sessions with their own context, which may inherit
history/configuration, run in the background, and wake a parent.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as a frame's `native`, except credential configuration
values are redacted before recording; the cross-runtime `events` are what
OAR read out of it. Control calls are request/response record pairs. The
profile declares `capabilities` `{ queue: { durable: false }, attribution:
"nested", images: true }` and its steer params, so the session has `steer`.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| Grok executable/process | One `grok agent --always-approve --no-leader stdio` subprocess per OAR Session; its exit is an `exited` response record (answering `dispose` when OAR caused it, `requestId ""` when Grok died on its own). |
| Persistent native session | `Session.id` is the native ID; `SessionOptions.resume` attaches by that ID with a fresh stream (seq 0, no history rebuild). |
| Handshake answers | `initialize`, `authenticate`, `session/new`/`resume`/`load`, `session/set_model`, `session/set_config_option` answers are frame records; the model and `reasoning_effort` level they report are `model` and `effort` events, so `Session.model()` and `effort()` are folds. |
| Prompt delivery and native execution | Controls are `toRuntime` requests answered accepted or rejected; each `session/prompt` RPC answer is a frame, the one closing the turn carrying `turn_ended` and `usage`. A steer (`_meta.sendNow`) adds another prompt RPC to the same turn. No `spanId`: no Grok frame carries a turn id. |
| `session/update` notifications | One frame per notification, for every session id; events for message/thought/tool/usage/model updates, none for unknown kinds; nothing is dropped. |
| `_x.ai/*` vendor notifications | Subscribed by name (`GROK_EXTENSION_NOTIFICATIONS`), each recorded with no events under the session id its envelope names, with MCP credential values redacted; one naming a parent/child pair links `Session.graph()` (`via: "tool_call"`). |
| Native child sessions | A frame for another session id is a derived child-session record (its own `sessionId` on the envelope, `agentPath []`, a graph node). Attribution tier `nested`. |
| Client-side terminal and permission duties | Every reverse request is a `toApp` request record (verbatim, under the runtime's JSON-RPC id) and OAR's automatic answer the matching `answered` response; terminals are hosted, permissions follow the fixed allow policy. `events()` reads the pair as `app_request` (method as `type`) and `app_answered`. |

The implementation is divided between the [Grok profile](../../packages/oar/src/runtimes/grok/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[event projection](../../packages/oar/src/shared/acp/projection.ts), and
[client app](../../packages/oar/src/shared/acp/client-app.ts).

ACP `tool_call_update` reports `status: "completed" | "failed"` ([src]
ACP schema `ToolCallStatus`); OAR maps those to `tool_call_ended.result:
"ok" | "failed"`, and a non-terminal or missing status leaves the field
absent. "[sym]" below means the name exists in the binary's symbol table but
has never been seen on a live wire.

## Capability details

### Starting, authenticating, and creating a session

Native ACP starts with `initialize { protocolVersion, clientCapabilities,
clientInfo, _meta? }`, followed by `authenticate { methodId }` when needed.
`session/new { cwd, mcpServers, _meta? }` returns a new `sessionId`, model
state, and metadata. Credentials must be available in the runtime environment.

**Mapped:** OAR selects the advertised default auth method
(`_meta.defaultAuthMethodId`) or `cached_token`, and sends noninteractive
startup hints in the `initialize` `_meta` (`clientIdentifier: "oar"`,
`clientType: "generic"`, `startupHints: { nonInteractive, skipGitStatus,
skipProjectLayout }`). It advertises terminal support, disables client
filesystem methods, and gives each opening request a 15-second deadline. The
session request supplies the session's `mcpServers` (`[]` without them; see
[session MCP servers](#session-mcp-servers)) and `_meta: { yoloMode: true }`.
The `authenticate` answer's `_meta` carries the account email and
`subscription_tier`; the `session/new` answer names the model
(`models.currentModelId`). Spawn, auth, and creation errors reject
`grokRuntime.session(...)`; a failed open kills the process before rejecting.

The shared ACP transport retains protocol failures in the thrown error's
`cause` as `{ method, native }`, including native `code`, `message`
and `data`. The SDK error class and existing auth/model classification are
preserved. MCP credential values are removed from both `data` and the
cause before the error reaches the host; previously only message/stack
were redacted. This also applies to Kimi, OpenCode and Antigravity opens.
Spawn errors keep their safe diagnostic fields, never Node's original
error containing the command's arguments.

### Resuming, loading, and forking

Native `session/resume { sessionId, cwd, mcpServers, _meta? }` returns
configuration/model state and metadata for the existing ID, with **no
transcript replay and no code restoration**. Extra directories and chat-kind
sessions are rejected in the baseline source version. `session/load` accepts
the same identity/workspace fields but delivers history notifications before
its response. Its `_meta.cursor` can restrict replay; configuration or
`_meta['x.ai/restore_code']` can request checking out the persisted HEAD.
See the [attach policy](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L120-L153)
and [resume handler](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1552-L1575).

With a previously probed available installation, callers use:

```ts
const resumed = await grokRuntime.session(installation, {
  cwd,
  resume: previousSessionId, // Exact earlier Session.id, not a prompt/turn ID.
});
const next = resumed.prompt("Continue");
```

**Mapped:** OAR chooses `session/resume` when
`agentCapabilities.sessionCapabilities.resume` is `true` or an object,
otherwise `session/load` when `loadSession === true`, otherwise rejects
(`ACP runtime does not support session resume`). This is capability
selection, not a retry after a failed resume. An optional model is applied
afterward with `session/set_model`. The `session/resume` answer carries
`models.currentModelId` (a `model` event), preceded by `background_tasks` and
`model_changed` vendor pushes; the resumed session keeps the id, opens at
seq 0, and recalls the earlier transcript (`live-contract/resume`). Grok
itself refuses a resume naming another directory than the session's own:
`session()` rejects with its `Path not found.` (1.0.46, 2026-10-03,
[resume in another directory](resume-cwd.md)). Native
persistence errors carry [stable error data](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/session/persistence.rs#L2496-L2516);
A resume/load failure with `data.code === "FS_NOT_FOUND"` becomes
`SessionNotFoundError`, retaining the requested `sessionId` and method/native
error in `cause`. This is absence for the supplied cwd, not a claim about
other directories; reuse the cwd stored with the id. Other opening failures
keep their original errors
([missing targets](../spec/runtime-matrix.md#missing-resume-targets)).
The 1.0.5 snapshot establishes advertised resume support, not all
newer-source details.

Native resident attachment can report
[`_meta['x.ai/runningPromptId']`](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1456-L1522).
OAR starts a fresh process, ignores that field, and creates no handle for
previous execution; it retains neither load-time transcript nor replay
cursor. Successful attachment does not establish that an interrupted tool
restarted or an old turn completed. Concurrent same-ID controllers,
cross-process live attachment, and load-fallback code effects remain
**unverified** through OAR.

Native [session fork](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/extensions/session_admin.rs#L994-L1007)
exists as `x.ai/session/fork`; OAR exposes no fork operation.

### Interrupted input

Grok's `sendNow` steering cancels the active prompt and starts another.
On 1.0.46, an immediate abort could cancel the replacement before its input
was read: a subsequent provider request omitted it. If the abort waited
until the replacement reached the provider, its text remained in later
requests. Both runs reported `cancelled` / `MidTurnAbort`; the early
replacement's usage could even repeat the previous prompt's totals.

OAR does not yet have a reliable per-input consumption or discard signal
for this race. It records those native replies without `input_dropped`;
blindly treating every cancelled steer as unread would return already-read
input for duplicate delivery. The source's running-prompt queue removal
explains the early loss but does not establish whether a cancelled prompt
reached the transcript. Inputs remain placed at request, as for other ACP
runtimes. [Comparison, source and reproducible probe](../../experiments/input-interruption-2026-10-08.md).

### Prompting, steering, queuing, and cancellation

Native `session/prompt { sessionId, prompt: [{ type: "text", text }] }`
streams updates and eventually answers the prompt request. Attachment itself
submits no prompt. Native [prompt identity](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1074-L1119)
and [queue/send-now dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1288-L1343)
are vendor-specific semantics beyond standard ACP.

**Images (mapped, against the advertisement):** grok's `initialize` answers
`promptCapabilities.image: false`, yet an ACP `image` block reaches its model
(grok 1.0.44, 2026-09-29: with `initialize` rewritten to advertise images, a
plain green PNG named `probe.png` with "don't run any tools, just look: what
color fills it?" was answered "Green. The image is a solid bright green
fill.", and the same prompt without the image "NO IMAGE"; allowed tools, grok
instead saved the image under `~/.grok/sessions/` and decoded its pixels in
Python). Hence `capabilities.images: true`; if a later grok refuses image
blocks, the prompt fails with grok's own error and this override goes
([test](../../tests/acp/acp-session-images.test.ts)).

For image-only input OAR sends ACP image blocks without a text block.
Grok 1.0.46 adds its own image-file description and empty-query wrapper
inside a nonempty text part, beside the provider's image URL. It drops
images smaller than 8×8 pixels before sending and writes an
`image_dropped_notice` instead ([recorded probe and normalizer source](../../experiments/image-only-2026-10-08.md)). The [image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts) uses a 32×32 PNG and confirms
image delivery without an empty text block, using a local scripted model.

**Prompt (mapped):** `prompt()` records a prompt request and answers it
`accepted` once the `session/prompt` RPC is on the wire (no deadline; cancel
bounds its lifetime), or `rejected` (`busy` while a turn is active; the
transport error when the process is gone). Acceptance never waits for native
acknowledgement. The RPC answer is Grok's own turn end: a frame
`session/prompt` with `native` = the answer, a `turn_ended` event
(`stopReason: "cancelled"` → aborted, else completed) and a `usage` event
from `_meta`. An RPC error answer is a frame `session/prompt/error` with a
failed `turn_ended`: -32003 is `rate_limited`, and a -32603's class is the
`error_type` of the `retry_state` update that ended Grok's retries
([failure evidence](../spec/runtime-matrix.md#opencode-kimi-grok-antigravity-acp)). A process exit instead
is an `exited` response, classified by the folds as described below. Around each prompt Grok pushes `_x.ai/sessions/changed`
(`working`, then `idle`) and, after `turn_completed`,
`_x.ai/session/prompt_complete` (`promptId`, `stopReason`,
`cancellationCategory`); all are frames with no events.
[Turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[test](../../tests/acp/acp-session.test.ts).

**Steer (mapped; a cancel-and-rerun natively):** `steer()` sends another
`session/prompt` with `_meta.sendNow` inside the same turn (otherwise rejected
`no_active_turn`, reason `not_steerable: no active turn`); each answer is its own frame, and
only the one that leaves no request pending carries `turn_ended`, with the
newest request's outcome. Natively `_meta.sendNow` is **not an injection
into the running model call**: Grok answers the running prompt `stopReason:
"cancelled"` with `_meta.cancelTrigger: "send_now"` and
`cancellationCategory: "MidTurnAbort"` (the vendor `prompt_complete` says the
same), while interrupted terminals keep running to completion (their
`wait_for_exit` answers land afterwards), then starts a fresh model turn that
re-issues the interrupted tool calls under new call ids and answers with the
steered text. OAR folds both answers into the one turn; a steer costs a
re-run of whatever the interrupted call was doing. (`live-contract/steer`;
fixture replay in
[`acp-grok-wire-shapes.test.ts`](../../tests/acp/acp-grok-wire-shapes.test.ts).)

**Queue (mapped):** `queue()` is a host-memory FIFO
(`capabilities.queue.durable: false`), drained one message per turn end; a
drained input runs as a spontaneous turn with an answer but no prompt request
of its own, and held input is dropped once the stream says the runtime is
unreachable (`live-contract/queue`). `withdraw(inputId)` takes an input out
of this FIFO before it is prompted (`accepted`) and answers `not_queued`
after; grok's own `x.ai/queue/remove` is a different queue and stays
unmapped ([input cancellation](input-cancellation.md),
[test](../../tests/acp/acp-session-withdraw.test.ts)).

**Abort (mapped):** `abort()` sends `session/cancel` and answers `accepted`;
the turn's end is still the cancelled prompt answer, which Grok delivers
within about a second (`turn_completed stop_reason: cancelled`,
`prompt_complete cancellationCategory: MidTurnAbort`, then the
`session/prompt` answer with `turn_ended: aborted`). If no answer arrives
within ten seconds, OAR kills the process and the `exited` response is the
turn's end, read as `aborted` by the folds because the abort was accepted.
The exit code stays on the exit response. A late abort is rejected `no active turn`. Effects on background
children remain **unverified**. (`live-contract/abort`,
`live-contract/busy-and-late-control`.)

**Unreachable runtime:** a `dispose` mid-turn cancels first, so the stream
holds the cancelled answer (`turn_ended: aborted`) before `request dispose`,
`response exited` (code 143 from OAR's SIGTERM after `session/close`). If
there is no native turn end before exit, the dispose request makes that exit
an `aborted` outcome in the folds. When
Grok dies on its own (SIGKILL), the stream gets `response exited` with
`requestId ""` and code `null` and no turn end from the runtime
(`runtime_exited` for `awaitTurnEnd`); every later
prompt/steer/queue/withdraw/abort is rejected `runtime exited` by the
kernel's reachability gate (read off the
stream, not an adapter flag) and a later `dispose` is answered `accepted`.
(`live-contract/dispose-mid-turn`, `live-contract/kill-runtime`;
[test](../../tests/acp/acp-session.test.ts).)

### Events, history, and child sessions

**Mapped:** a basic one-word turn is 50 records: the handshake answers
`initialize`, `authenticate`, `session/new` (model event); then per prompt
`_x.ai/sessions/changed` (working), several `available_commands_update`
pushes, `session_summary_generated` + `session_info_update` (Grok titles the
session), token-level `agent_thought_chunk` and `agent_message_chunk` (each
with `_meta.eventId`, `promptId`, `totalTokens`, `chunkId`),
`response_completed`, `turn_completed`, `sessions/changed` (idle),
`prompt_complete`, and the `session/prompt` answer (`turn_ended` + `usage`).
`native` is present on every event and seqs are dense
(`live-contract/basic`). Views preserve text, reasoning, tool wire IDs, tool
boundaries, context snapshots, and model reports; detail strings truncate at
10,000 characters but `native` never does. A non-terminal `tool_call_update`
for a known call that carries `rawOutput` is a `tool_call_progress` event
(its `content` is never read as progress). A tool the runtime never ended
gets no synthetic end; the turn's `turn_ended` event is the only closure.
Grok reports no retry through ACP, so `retry` never appears.
[Projection](../../packages/oar/src/shared/acp/projection.ts).

**Two notification methods.** On the wire `session/update` carries only
standard kinds (`available_commands_update`, `session_info_update`,
`agent_thought_chunk`, `agent_message_chunk`, `user_message_chunk`,
`tool_call`, `tool_call_update`), for the root and each child id alike.
`_x.ai/session_notification` is its vendor twin (same envelope
`{sessionId, update: {sessionUpdate: <kind>, …}}`) and carries every
non-standard kind: `model_changed`, `session_summary_generated`,
`tool_call_delta_chunk`, `pending_interaction`, `interaction_resolved`,
`response_completed` (per model call, snake_case usage), `turn_completed`
(per prompt, camelCase usage with `modelCalls` and `costUsdTicks`),
`last_turn_summary`, `background_tasks` (pushed by `session/resume`), and the
sub-agent lifecycle. The split matters because the ACP SDK (1.4.0) client
validates every `session/update` against a closed union of the standard kinds
*before* any handler runs; a vendor kind on that method would be dropped
with an "Error handling notification" line on OAR's stderr. Grok does not do
that; the hazard is latent, not observed. The SDK also routes only
registered notification methods and silently discards the rest, so the
profile subscribes by name to every vendor method Grok is known to emit
(`GROK_EXTENSION_NOTIFICATIONS`): `_x.ai/session_notification`,
`_x.ai/sessions/changed` (the resident session table, `activity:
working|idle`, `removed` on close), `_x.ai/session/prompt_complete`, and the
per-session-start connection housekeeping `_x.ai/queue/changed` (the delivery
queue, with the prompt text), `_x.ai/models/update`, `_x.ai/settings/update`,
`_x.ai/announcements/update`, `_x.ai/mcp/servers_updated`,
`_x.ai/mcp/init_progress`, `_x.ai/mcp/server_status`, `_x.ai/mcp_initialized`.
Still [sym]-only and kept registered: `_x.ai/session/update`,
`_x.ai/task_backgrounded`, `_x.ai/task_completed`, `_x.ai/session/usage`.
An unlisted method is a frame OAR never sees (`grok-wire-tap.ts` shows wire
versus stream; [wire-shape test](../../tests/acp/acp-grok-wire-shapes.test.ts)).

**Children (nested attribution):** native child
[spawn events](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs#L609-L634)
identify parent/child sessions and parent prompt; [completion events](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/subagent/spawn.rs#L318-L368)
report status, usage, and whether the parent will wake. On the wire, the
root's `spawn_subagent` tool call produces `subagent_spawned` and
`subagent_progress` frames carrying `update.parent_session_id` /
`update.child_session_id` (snake_case, nested under `update`; also
`subagent_id`, `attempt_id`, `parent_prompt_id`, `subagent_type`, `model`),
while `subagent_finished` names only `child_session_id` (plus `status`,
`output`, `will_wake`), the parent being the envelope's `sessionId`. In
between, the child's own `session/update` frames (`user_message_chunk` with
the delegated prompt, thoughts, `tool_call`, `tool_call_update`, text) arrive
under the child id, and the child's own `response_completed`,
`turn_completed`, `pending_interaction`/`interaction_resolved`,
`tool_call_delta_chunk`, and per-child `_x.ai/queue/changed` /
`_x.ai/mcp_initialized` are vendor frames whose envelope `sessionId` is the
child's. The root's `tool_call_ended` content embeds the child's report plus a
`<subagent_meta>` block.

OAR records `session/update` and vendor frames alike under the session id
their envelope names, so the child's ledgers land under the child and the
parent's `subagent_*` lifecycle under the parent. A vendor frame naming a
parent/child pair, in either spelling (`parent_session_id`/`parentSessionId`)
at either depth (`acpLineageOf`, [records.ts](../../packages/oar/src/shared/acp/records.ts)),
links the graph `via: "tool_call"`; one child spawn yields two nodes and one
edge. A child whose lineage notification was not observed stays a node
without an edge; OAR never fabricates one. There is no child control handle.
(`live-contract/subagent`; [wire-shape
test](../../tests/acp/acp-grok-wire-shapes.test.ts) with fixture
[`fake-acp-grok.mjs`](../../tests/fixtures/fake-acp-grok.mjs).)

**Unsolicited response:** Grok has been seen sending, once per session, a
JSON-RPC *response* with `id: "skills-reload"` matching no request of OAR's
(the SDK logs "Got response to unknown request skills-reload"). It does not
reproduce under the wire tap, so its params are unrecorded; it does not reach
the stream.

**History:** the retained stream backs `rawEvents(observer, cursor)` for the
life of the process; a mid-turn subscribe with `afterSeq` replays exactly the
retained records and continues live; a full replay equals `records()`
(`live-contract/cursor`). There is no native-history enumeration and no
rebuild after the process died.

### Service tiers

`SessionOptions.serviceTier` is explicitly refused with
`UnsupportedOptionError`, declared in `Runtime.refusedSessionOptions`.
No per-session native setting plus applied-state readback has been verified
for this adapter; `listModels` therefore advertises no service tiers. OAR
does not silently ignore a requested tier or alter a global default.

### Models and instructions

Native model discovery uses `_x.ai/models/list`; model selection uses
`session/set_model`. [OAR listing](../../packages/oar/src/runtimes/grok/list-models.ts)
handles the extra result envelope and filters hidden/unselectable entries
([`grok-list-models.ts`](../../experiments/grok-list-models.ts)). **Mapped:**
open-time model selection applies `session/set_model` after the session
opens, and `model()` folds the runtime's reports: `models.currentModelId`
from `session/new`/`resume`, then the `set_model` answer's `_meta.model` (the
applied id, never the request). A non-existent id is rejected `Invalid
params`, so `session()` throws at open (`live-contract/bad-model`). The
runtime default model is not stable across sessions: with no request from
OAR, `session/new` has reported both `grok-4.6` and `grok-4.5`; a
`model_changed` vendor push precedes the answer and names the same id.
[Model read-back](../../packages/oar/src/shared/acp/model.ts),
[test](../../tests/acp/acp-session-model-usage.test.ts).

**Effort (mapped).** The effort menu is per model. `_x.ai/models/list`
entries carry it under `_meta` ([env] 1.0.41: `supportsReasoningEffort`,
`reasoningEffort` (the default), `reasoningEfforts: [{id, value, label,
description, default}]`; grok-4.7 offers xhigh/high/medium/low, grok-4.5
high/medium/low), and the lister reads it there. The session channel is the
ACP config option `reasoning_effort` in the `thought_level` category, which
`session/new` and `session/resume` advertise. `SessionOptions.effort` is
`session/set_config_option {configId: "reasoning_effort", value}`, sent
after any `set_model` (a model switch re-derives the option's menu for the
new model). grok answers with every option's current value, then pushes
`_x.ai/session_notification {update: {sessionUpdate: "model_changed",
model_id, reasoning_effort}}` and a `config_option_update`; the answer and
the update carry the `effort` event, and a `currentValue` other than the
request refuses the open. An unknown level is refused `-32602 Invalid
params` ("unknown reasoning_effort value"), so the open rejects with that
message. The `--reasoning-effort` flag of `grok agent` does not reach ACP
sessions: with it, `session/new` still reported `high`. grok persists the
level with the session: a resume answers the level last set (live
2026-09-29: `low`), and a resume that asks for none keeps it. The
`_x.ai/sessions/changed` upserts carry `reasoningEffort` too (`low` while
the turn is `working`), recorded verbatim with no event. Live effort
changes are **unexposed** ([native surfaces](live-configure.md)).
[ACP effort channel](../../packages/oar/src/shared/acp/effort.ts),
[test](../../tests/acp/acp-session-effort.test.ts).

Grok's initialization extensions accept system-instruction configuration.
`systemPrompt` uses `_meta.systemPromptOverride`. On a new session,
`appendSystemPrompt` alone uses `_meta.rules`, retaining native instructions.
When both are given, OAR sends **one override**, `systemPrompt` followed by a
blank line and `appendSystemPrompt`. This works on both creation and resume.
These are Grok extensions, not standard ACP fields.

**Conditional refusal:** resuming with only `appendSystemPrompt` throws
`UnsupportedOptionError` naming that option before launch: Grok 1.0.46 does
not reapply `rules` on resume. A resumed `systemPrompt` is supported and
replaces the saved system instructions. No prompt options preserves them.

[Native request probe](../../experiments/grok-prompt-options.ts), 2026-10-07,
**1.0.46 (`2765805b9442`)**: an isolated native home and custom model pointed
at a local provider capture the actual system message. Raw override plus
rules sends only the override; resumed rules leaves the old system message;
resumed override replaces it. OAR's combined override reaches the provider
with both strings in order on creation and resume. The provider deliberately
stops after capture, so these are request assertions, not model-obedience
claims. Earlier fixed-word response probes were inconclusive and are not the
basis for refusing an option.

The public source at
[`2bdd1d6a`, `mvp_agent/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs#L976-L1030)
likewise selects override before rules and applies rules only to new
sessions. Its
[`agent_ops.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs#L4737)
applies an override on load. That source revision is not asserted to be the
installed binary's build revision; the request capture establishes behavior.

| Session option | Native channel and result |
| --- | --- |
| `cwd` | ACP new/resume directory; native rejects a resume in a different directory. |
| `resume` | ACP resume when advertised, otherwise load; native session identity. |
| `model` | ACP `session/set_model`, with native read-back. |
| `effort` | ACP `thought_level` config option; the similarly named CLI flag does not configure ACP sessions. |
| `systemPrompt` | Initialize override, on both new and resumed sessions. |
| `appendSystemPrompt` | Initialize rules on new sessions, or combined override with `systemPrompt`; append-only resume is refused. |
| `env` | Child-process environment, including tools. |
| `mcpServers` | ACP `mcpServers` on new and resumed sessions ([session MCP servers](#session-mcp-servers)). |

Launcher/config audit: `grok agent --help` also exposes agent profiles,
plugin directories, model and reasoning flags. None is needed to replace the
verified ACP channels above. OAR does not write a user's native configuration
or redirect their session storage to inject an option.

### Context usage, billing, and compaction

**Context (partial):** `Session.contextUsage()` reads the prompt answer's
`_meta.totalTokens` (or `contextTokens`), Grok's running context count
(about 16.8k after a one-word turn). No answer carries a window, so
`contextWindow`/`percent` are `null` even though `session/new` advertises
`totalContextTokens: 500000` per model. The count rides the answer itself
(Grok's `response_completed`/`turn_completed` precede it), so the profile
configures no post-answer wait (`usageUpdateAfterPrompt` unset).
[Usage reader](../../packages/oar/src/runtimes/grok/session.ts).

**Billing (mapped):** `Session.usage()` is the sum of the per-prompt
`_meta.usage` ledgers (`inputTokens` including cached reads, `outputTokens`;
a ledger missing either side is ignored rather than half-counted). The
ledger's `cachedReadTokens` sums as `cacheRead` and its `cacheCreationTokens`
as `cacheWrite`, each only from ledgers that carry it (live 1.0.25 basic
answer: 1280 and 0; whether `inputTokens` holds a nonzero cache write is
unverified; [spec](../spec/attribution.md#cache-reads-and-writes)). Each
ledger is what THAT prompt billed, summed over every model call the prompt
caused, not a session total: repeated one-word turns bill about 16.8k input
each; a send-now steer's two answers carry two disjoint ledgers (the
cancelled prompt's one call, 16776/222, then the steering prompt's own two
calls, 34420/279 with `modelCalls: 2`: the re-issued tool round plus the
final answer), so summing both counts nothing twice; and a prompt that
spawned a child bills the child's calls inside its own ledger (53321/355,
`modelCalls: 4` = the parent's two and the child's two `response_completed`
frames, `input_tokens` + `cache_read_input_tokens` each, while the child's
own `turn_completed` reports 19280/96, `modelCalls: 2`). The adapter
therefore accumulates only the root's prompt ledgers and stamps the running
total on each answer's `usage` event; the root's `usage()` already covers
the child's spend. The child's own ledgers (its `response_completed` per
call, its `turn_completed`, and the parent's
`subagent_progress`/`subagent_finished` `tokens_used`) are recorded verbatim
(`native` only, child-envelope ones under the child's session id) and
deliberately NOT folded a second time. (`live-contract/multi-turn`, `steer`,
`subagent`; [wire-shape test](../../tests/acp/acp-grok-wire-shapes.test.ts).)

Native [explicit compaction dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L2561-L2563)
exists through `x.ai/compact_conversation`; automatic compaction remains
native harness behavior. OAR has no typed compaction operation, and no ACP
frame reports one, so Grok sessions never carry `compaction_started` or
`compaction_ended` events.

### Tools, MCP, and permissions

Native ACP supports terminal and permission reverse requests; vendor tools
and configured MCP integrations execute within the harness. **Mapped:** OAR's
[terminal host](../../packages/oar/src/shared/acp/terminal.ts) hosts
terminals, including Grok's full shell-line `command` compatibility. A tool
turn opens with `tool_call` `title: "run_terminal_command"` and `rawInput`
`{command, description}` (the shell line and the agent's account of it;
`classifyTool` reads it as `run_command` with both; the next update's
`rawInput` adds `is_background` and `variant`, a `tool_call_input` with the
whole input), runs through
`terminal/create|wait_for_exit|output|release` reverse requests (four
`toApp` records with `answered` responses, terminal output payloads
verbatim), and closes with a `tool_call_update` whose
`rawOutput` is `{type: "Bash", output: [<bytes>], output_for_prompt:
"exit: 0\n…", exit_code: 0, signal: null}` and whose `content` is an ACP
content block holding the same output as text. The `tool_call_ended` event
carries the content block's text as a text part of `content` (the byte array
stays in `native`) and `exit_code` as `exitCode` (`null` for a signal exit);
a closing update without content (`read_file`, `search_replace`) falls back
to `rawOutput` as one `other` part. Under `--always-approve` no
`session/request_permission` arrives, though Grok still pushes
`pending_interaction`/`interaction_resolved` pairs; if one did, the
[client app](../../packages/oar/src/shared/acp/client-app.ts) selects
`allow_always`, then `allow_once`, otherwise `cancelled`, alongside the
launch/session yolo settings.

There is no application approval callback or generic client-tool callback
(both **unexposed**); per-session MCP servers are
[below](#session-mcp-servers). Passing no MCP servers and disabling client
filesystem methods does not disable every vendor-configured tool.

### Session MCP servers

`SessionOptions.mcpServers` is ACP's `mcpServers` on `session/new` and
`session/resume`, in ACP's `McpServer` shape (stdio `{name, command, args,
env}`, http `{type: "http", name, url, headers}`, `env` and `headers` as
`{name, value}` lists; `args`, `env` and `headers` always sent;
[mapping](../../packages/oar/src/shared/acp/mcp-servers.ts),
[test](../../tests/acp/acp-session-mcp-servers.test.ts)). grok declares
`mcpCapabilities` http and sse, so http entries are sent (to an agent that
declares no http, OAR refuses one with `UnsupportedOptionError`). An empty
or repeated name fails the open before grok starts. Measured on grok 1.0.46
against a scripted provider: fresh `HOME` and `GROK_HOME`, a `config.toml`
custom model `[model.aimock-model]` (`api_backend = "chat_completions"`,
dummy `api_key`) and a dummy `XAI_API_KEY`; `initialize` then offers
`xai.api_key` (the default, which OAR picks) and `grok.com`, so no grok.com
login is involved
([vendor test](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts),
[harness](../../sea-trial/harness/aimock-acp.ts)):

- grok declares no MCP tool to the model. The model calls a server's tool
  through grok's `use_tool` meta-tool, `{tool_name: "<server>__<tool>",
  tool_input: {...}}` (`search_tool` is offered beside it), so the ACP
  `tool_call` title of every MCP call is `use_tool`. The tool result reached
  the provider as the server wrote it, so the server ran with the entry's
  `env` (stdio) or `headers` (http).
- A resume remembers none: `session/resume` given them spawns the servers
  again and the model called the stdio one; probed, resumed with none,
  nothing is attached.
- On a name clash the session's `echo` wins over the user's `config.toml`
  `[mcp_servers.echo]` (probed: the user's is never spawned), and the user's
  `userecho` is still called. `_x.ai/mcp/list` and
  `_x.ai/mcp/servers_updated` still describe the user's `echo` definition,
  not the one running (probe).
- grok's per-process `--plugin-dir <DIR>` flag (before `stdio`;
  `<DIR>/.grok-plugin/plugin.json` and `<DIR>/.mcp.json`) also attached
  servers in a probe. OAR does not use it: the ACP param works, and ACP
  launch flags belong to #171.

The credentials reach grok only in the open request's params, which OAR does
not record; a failed open's error is redacted (`[redacted]`). A probe found
the session's values in no notification or answer and not on disk, and the
vendor test asserts no record holds one. grok's MCP notifications carry:
`_x.ai/mcp/servers_updated` the config-file servers only (`[]` with session
servers only), `_x.ai/mcp/init_progress` and `_x.ai/mcp_initialized`
counts, `_x.ai/mcp/server_status` a name, source and status.

**Credential values do not enter records.** Grok 1.0.46 sends the user's
`config.toml` stdio `env` values in `_x.ai/mcp/servers_updated`, even without
session servers. OAR recursively replaces the values of `env`, `headers`, `http_headers` entries and
`bearer_token` / `bearerToken` fields with `[redacted]`, preserving names,
array/map shape and all other fields. The same rule applies to these fields
at any depth in the other registered MCP notifications, independent of container names. It runs before startup buffering
and kernel recording, so `records()`, live `rawEvents()` and replay all see
the redacted form. Grok's configuration and the credentials its servers
receive are unchanged. This credential exception is the only change to
verbatim notification recording; free-form text and fields with other names are unchanged.
Before 0.32.1 OAR recorded these values in plain text; a host that kept such
records rewrites them with `redactRecord`, which applies the same rule
([record stream](../spec/record-stream.md)).

Audit of the public source at `2bdd1d6a`: the
[MCP catalog](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/mcp.rs)
copies stdio `env` and omits HTTP headers. `server_status` carries state,
reason and optional detail; `init_progress` and `mcp_initialized` carry
counts and timing. `initialize` starts with an empty MCP catalog. No other
registered notification in this audit declares server credential fields.
The source revision is not asserted to match the installed binary. The
[Grok vendor test](../../sea-trial/vendor/grok-mcp-redaction.vendor.test.ts)
reproduces the 1.0.46 leak with a dummy credential, then checks the entire
record stream, live/replayed observations, unchanged config and the MCP
server's credential fingerprint. The
[fixture regression](../../tests/grok/grok-mcp-redaction.test.ts) also covers
HTTP credential shapes and notifications before and after session opening.

### Process ownership, release, installation, and account usage

Native ACP advertises session close. **Mapped:** OAR owns the spawned
process; disposal cancels active work, attempts `session/close` when
advertised (2-second deadline), kills its process, and disposes hosted
terminals. On POSIX the process and each hosted terminal command lead their
own process groups, so OAR's signals reach what they started (a shell line's
children too). The runtime gets SIGTERM, then SIGKILL if it is still running
after a grace period (10 s, or `OAR_KILL_GRACE_MS`), so disposal settles even
when Grok ignores SIGTERM ([test](../../tests/session-dispose.test.ts)); the
SIGKILL, or Grok's exit if that comes first, also takes its descendants that
left its group, read from the process table when the kill begins and before
the SIGKILL (as for [claude](claude.md#process-ownership-environment-installation-and-account-usage));
hosted terminals are SIGKILLed at release and disposal. A terminal still
pending `terminal/wait_for_exit` at disposal is answered `{exitCode: null,
signal: "SIGKILL"}` *after* the `exited` response (the spec keeps late
facts). Disposal does not delete the persistent native session and supplies
resource release, not detached execution or a lease against other
controllers. The environment overlay applies to the child process and to
hosted terminals. A `null` entry removes an inherited variable from both
([environment contract](../spec/runtime-matrix.md#session-environment)).

On Windows, the shared ACP session uses `taskkill /T /F` for disposal and
the abort fallback, so termination reaches the runtime behind its launcher
and its descendants ([test](../../tests/session-dispose.test.ts)).
See [host-exit cleanup and limits](../spec/record-stream.md#the-rules).

Installation checks `OAR_GROK_BIN`, PATH, and the official script/npm layouts
(`$GROK_BIN_DIR`, `$GROK_HOME/bin`, `~/.grok/bin`), probing with
`grok agent stdio --help`. When none is found, `install` runs xAI's script,
`curl -fsSL https://x.ai/cli/install.sh | bash`
([Grok Build docs](https://docs.x.ai/build/overview); macOS and Linux;
[runtime install](../spec/install.md), [sandbox run](install.md)). That
method because its copy is the one `grok update` updates: `grok update
--check --json` reports installer `internal`, where an npm install would be
a second copy. [Account usage](../../packages/oar/src/runtimes/grok/account-usage.ts)
separately opens a connection and queries `_x.ai/billing` (plus
`_x.ai/auth/info` for the email). No billing `config` is `unsupported`
`quota_unavailable`; a config that carries none of `creditUsagePercent`,
`used` and `monthlyLimit` reads as zero usage, as grok's own `/usage` shows it
(1.0.46, an unused account; [account usage](../spec/account-usage.md),
[test](../../tests/grok/grok-account-usage-reader.test.ts)). Account quota,
prompt billing, and context occupancy are distinct APIs and measurements.
[Installation](../../packages/oar/src/runtimes/grok/installation.ts),
[install](../../packages/oar/src/runtimes/grok/install.ts).

Grok updates itself by default. Launched from `~/.grok/bin`, as the script
install puts it, `grok agent stdio` (OAR's own launch) checks for a release
and silently repoints the link (a sandboxed 1.0.44 became 1.0.46 within 40
seconds of an idle launch, 2026-10-01), so a grok session can start on a
different version than `installation()` reported. `GROK_DISABLE_AUTOUPDATER=1`
or `[cli] auto_update = false` stop it; an explicit `grok update` ignores
both. **Not mapped:** OAR passes neither, so the user's setting decides.
`checkUpdate` reads `grok update --check --json` and `upgrade` runs
`grok update` ([runtime updates](../spec/update.md)).

## Verification and open gaps

[`experiments/live-contract.ts grok`](../../experiments/live-contract.ts)
covers every promise above on a real SuperGrok login through the public
Session API, from a scratch cwd under `/tmp` (yolo mode edits files), across
the thirteen scenarios cited by name; [`grok-wire-tap.ts`](../../experiments/grok-wire-tap.ts)
compares the raw wire with the stream (which frames reach records; two
notification methods; lineage shape; per-prompt ledgers). The battery's
voyage recorder can write a late record (the post-`exited` terminal answer
above) into the next scenario's log: a recorder hazard, not a stream one.

[ACP session tests](../../tests/acp/acp-session.test.ts) and
[model/usage tests](../../tests/acp/acp-session-model-usage.test.ts) use a fake
agent for the record skeleton of a tool turn, busy/queue behavior, send-now
steer folding, toApp permission records, prompt-error versus process-exit
ends, resume identity, child-session records, extension-notification graph
edges, and model readback. [Grok wire-shape tests](../../tests/acp/acp-grok-wire-shapes.test.ts)
replay the 1.0.25 frames (fixture [`fake-acp-grok.mjs`](../../tests/fixtures/fake-acp-grok.mjs)):
nested snake_case lineage → graph edge, the envelope-parent
`subagent_finished`, never-fabricated lineage, listed versus unlisted vendor
methods, and per-prompt ledgers accumulating into `usage()`. [Terminal tests](../../tests/acp/acp-terminal.test.ts)
cover shell compatibility, truncation, and cleanup. [Snapshot tests](../../tests/acp/acp-vendor-snapshot.test.ts)
check recorded schema assumptions (1.0.5), not execution of the current
harness. The [CI behavior matrix](../../.github/workflows/ci.yml) runs real
Claude, Codex, and Pi backends, not Grok.

Open gaps: grok 1.0.41 pushes `_x.ai/session/setup {method: "session/new",
phase: "model_switch", sessionId}` while opening (seen 2026-09-29 below the
SDK), a vendor method not in `GROK_EXTENSION_NOTIFICATIONS`, so the SDK
drops it before the stream; concurrent children; cancellation with
background children (`will_wake`, `task_backgrounded`, `task_completed`);
usage across compaction; concurrent same-ID controllers, cross-process live
attachment and load-fallback code effects; the `skills-reload` response's
payload; the [sym]-only vendor methods; [session MCP
servers](#session-mcp-servers) on a real login and model (measured against
a scripted provider only; their vendor test runs locally,
`OAR_TEST=grok-aimock`, not in CI); the user's `config.toml` MCP `env`
values that `_x.ai/mcp/servers_updated` carries into the records. Design
should distinguish restoring
context, replaying observations, and adopting live execution; the Session
OAR returns does not imply all three.

## Disallowed tools

`SessionOptions.disallowedTools` is refused before launch and declared in
`refusedSessionOptions`. Grok 1.0.46's top-level CLI offers
`--disallowed-tools`, but `Command::Agent` / `run_agent_command` does not
forward those overrides into `agent stdio`. Its `--agent-profile` and ACP
`_meta.agentProfile` can replace the selected native agent definition;
OAR does not replace the user's harness merely to change tool selection.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go before `stdio`: `grok agent [OPTIONS] stdio [OPTIONS]` takes the agent's options (`--model`, `--agent-profile`, `--plugin-dir`) before `stdio`, which itself takes only `--debug` and `--leader-socket`. OAR passes them unchecked and never records them; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).
