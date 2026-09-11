# Grok runtime

Evidence baseline: native source
[`grok-build` `bc7f02e`](https://github.com/xai-org/grok-build/tree/bc7f02e)
(Grok 1.0.12); the [wire snapshot](../../tests/replay/fixtures/grok-acp-v1.vendor.json)
is Grok 1.0.5 (`5115b46bc9`, 2026-08-26) and the
[adapter experiment](../../experiments/acp-runtime.ts) ran on that binary
(2026-08-27).
Live observations below come from **grok 1.0.25 (`f7e67d6988e2`)**, darwin
arm64, runtime default model, on 2026-09-11 through
[`experiments/live-contract.ts grok`](../../experiments/live-contract.ts)
(scenario names are cited as `live-contract/<id>`) and the raw
[`experiments/grok-wire-tap.ts`](../../experiments/grok-wire-tap.ts) below the
SDK; see the [experiments index](../../experiments/README.md). Versions are
evidence baselines, not a support range; source-supported claims are not a
live check of a newer binary. The [spec](../spec/README.md) is not current OAR
behavior. See the [runtime index](README.md) for evidence and status
conventions.

## Native concepts and calling interfaces

Grok is a coding-agent harness. Its process owns sessions; each session owns
model context, configuration, incoming prompts, tool execution, and persistent
state. The ACP update log, model chat history, metadata, rewind points, and
compaction checkpoints serve different purposes. See the
[native session description](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/README.md#session-persistence).

The interactive TUI, headless `grok -p`, and `grok agent stdio` are calling
modes for that harness. OAR uses the last: ACP JSON-RPC over stdio, including
vendor extensions. ACP is bidirectional: Grok can ask its client to execute a
terminal command or decide a permission request while a prompt is running.

A native session ID identifies conversation continuity. A `promptId`, native
turn number, and JSON-RPC request ID have separate roles. Ordinary prompts
enter a delivery queue; `_meta.sendNow` selects immediate dispatch. Subagents
are independent child sessions with their own context, which may inherit
history/configuration, run in the background, and wake a parent. These native
concepts exist before OAR chooses its Session/Turn abstraction.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as an event's `native`; the cross-runtime `views` are what
OAR read out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| Grok executable/process | One `grok agent --always-approve --no-leader stdio` subprocess per OAR Session, launched with noninteractive profile settings; its exit is an `exited` response record (answering `dispose` when OAR caused it, `requestId ""` when Grok died on its own). |
| Persistent native session | `Session.id` preserves its ID; `SessionOptions.resume` attaches by that ID with a fresh stream (seq 0; no history rebuild). |
| Handshake answers | `initialize`, `authenticate`, `session/new`/`resume`/`load`, `session/set_model` answers are event records; the model they report is a `model` view, so `Session.model()` is a fold. |
| Prompt delivery and native execution | `prompt()` is a `toRuntime` request answered accepted/`busy`; each `session/prompt` RPC answer is an event, and the one closing the turn carries the `turn_ended` view (newest request's outcome) plus a `usage` view. A steer (`_meta.sendNow`) adds another prompt RPC to the same turn. No `spanId`: no Grok frame carries a turn id. |
| `session/update` notifications | One event per notification, `native` verbatim, for EVERY session id; views for message/thought/tool/usage/model updates, none for unknown kinds — nothing is dropped. |
| `_x.ai/*` vendor notifications | Subscribed by name (`GROK_EXTENSION_NOTIFICATIONS`), each recorded verbatim with no views under the session id its envelope names; one naming a parent/child session pair links `Session.graph()` (`via: "tool_call"`). |
| Native child sessions | An update or vendor frame for another session id is a derived child-session record (its own `sessionId` on the envelope, `agentPath []`, a graph node). Attribution tier declared `nested`; `capabilities` are `{ steer: true, queue: { durable: false }, attribution: "nested" }`. |
| Client-side terminal and permission duties | Every reverse request is a `toApp` request record (verbatim) and OAR's automatic answer the matching `answered` response; terminals are hosted, permissions follow the fixed allow policy. |

The implementation is divided between the [Grok profile](../../packages/oar/src/runtimes/grok/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[view projection](../../packages/oar/src/shared/acp/projection.ts), and
[client app](../../packages/oar/src/shared/acp/client-app.ts).
"Unexposed" below means a native capability has no current OAR operation;
"unverified" means the available evidence does not establish the behavior;
"[sym]" means the name exists in the binary's symbol table but has never been
seen on a live wire.

## Capability details

### Starting, authenticating, and creating a session

Native ACP starts with `initialize { protocolVersion, clientCapabilities,
clientInfo, _meta? }`, followed by `authenticate { methodId }` when needed.
`session/new { cwd, mcpServers, _meta? }` returns a new `sessionId`, model
state, and metadata. Credentials must be available in the runtime environment.

**Mapped:** OAR launches `grok agent --always-approve --no-leader stdio`,
selects the advertised default auth method (`_meta.defaultAuthMethodId`) or
`cached_token`, and sends noninteractive startup hints in the `initialize`
`_meta` (`clientIdentifier: "oar"`, `clientType: "generic"`,
`startupHints: { nonInteractive, skipGitStatus, skipProjectLayout }`). It
advertises terminal support, disables client filesystem methods, and uses
15-second deadlines for opening requests. Its session request supplies
`mcpServers: []` and `_meta: { yoloMode: true }`. The `authenticate` answer's
`_meta` carries the account email and `subscription_tier`; the `session/new`
answer names the model (`models.currentModelId`) and advertises
`totalContextTokens` (500000) per model. Spawn/auth/creation errors reject
`grokRuntime.session(...)`; a failed open kills the process before rejecting.

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
`agentCapabilities.sessionCapabilities.resume` is `true` or an object;
otherwise it selects `session/load` when `loadSession === true`, or rejects
(`ACP runtime does not support session resume`). This is capability
selection, not a retry after a failed resume. An optional model is applied
afterward with `session/set_model`. The `session/resume` answer carries
`models.currentModelId` (a `model` view), preceded by `background_tasks` and
`model_changed` vendor pushes; the resumed session keeps the id, opens at
seq 0, and recalls the earlier transcript (`live-contract/resume`). Native
persistence errors carry [stable error data](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/session/persistence.rs#L2496-L2516);
OAR propagates opening failures without a separate resume-error result type.
The 1.0.5 snapshot establishes advertised resume support, not all
newer-source details.

Native resident attachment can report
[`_meta['x.ai/runningPromptId']`](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1456-L1522).
OAR starts a fresh process, ignores that field, and creates no handle for
previous execution. It retains neither load-time transcript nor replay cursor.
Successful attachment does not establish that an interrupted tool restarted
or an old turn completed. Concurrent same-ID controllers, cross-process live
attachment, and load-fallback code effects remain **unverified** through OAR.

Native [session fork](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/extensions/session_admin.rs#L994-L1007)
exists as `x.ai/session/fork`; OAR exposes no fork operation.

### Prompting, steering, queuing, and cancellation

Native `session/prompt { sessionId, prompt: [{ type: "text", text }] }`
streams updates and eventually answers the prompt request. Attachment itself
submits no prompt. Native [prompt identity](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1074-L1119)
and [queue/send-now dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1288-L1343)
are vendor-specific semantics beyond standard ACP.

**Prompt (mapped):** `prompt()` records a prompt request and answers it
`accepted` once the `session/prompt` RPC is on the wire (no deadline; its
lifetime is bounded by cancel), or `rejected` (`busy` while a turn is active;
the transport error when the process is gone). Acceptance never waits for
native acknowledgement. The RPC answer is Grok's own turn end: an event
`session/prompt` with `native` = the answer, a `turn_ended` view
(`stopReason: "cancelled"` → aborted, else completed) and a `usage` view
from `_meta`. An RPC error answer is an event `session/prompt/error` with a
failed `turn_ended` (`runtime_exited` when the process died, else the
classified reason). Around each prompt Grok pushes `_x.ai/sessions/changed`
(`working`, then `idle`) and, after the answer's `turn_completed`, an
`_x.ai/session/prompt_complete` (`promptId`, `stopReason`,
`cancellationCategory`) — all events with no views.
[Turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[test](../../tests/acp/acp-session.test.ts).

**Steer (mapped; a cancel-and-rerun natively):** `steer()` sends another
`session/prompt` with `_meta.sendNow` inside the same turn (`rejected
not_steerable: no active turn` otherwise); each answer is its own event, and
only the one that leaves no request pending carries `turn_ended`, with the
newest request's outcome. What `_meta.sendNow` does natively is **not an
injection into the running model call**: Grok answers the running prompt
`stopReason: "cancelled"` with `_meta.cancelTrigger: "send_now"` and
`cancellationCategory: "MidTurnAbort"` (the vendor `prompt_complete` says the
same), while interrupted terminals keep running to completion (their
`wait_for_exit` answers land afterwards), then starts a fresh model turn that
re-issues the interrupted tool calls under new call ids and answers with the
steered text. OAR folds both answers into the one turn; callers should know a
steer costs a re-run of whatever the interrupted call was doing.
(`live-contract/steer`; fixture replay in
[`acp-grok-wire-shapes.test.ts`](../../tests/acp/acp-grok-wire-shapes.test.ts).)

**Queue (mapped):** `queue()` is a host-memory FIFO
(`capabilities.queue.durable: false`), drained one message per turn end; a
drained input runs as a spontaneous turn with an answer but no prompt request
of its own, and held input is dropped once the stream says the runtime is
unreachable (`live-contract/queue`).

**Abort (mapped):** `abort()` sends `session/cancel` and answers `accepted`;
the turn's end is still the cancelled prompt answer, which Grok delivers
within about a second (`turn_completed stop_reason: cancelled`,
`prompt_complete cancellationCategory: MidTurnAbort`, then the
`session/prompt` answer with `turn_ended: aborted`). If no answer arrives
within ten seconds, OAR kills the process, and the `exited` response is then
the turn's end (a `runtime_exited` failure to `awaitTurnEnd`, not an aborted
outcome). A late abort is rejected `no active turn`. Effects on background
children remain **unverified**. (`live-contract/abort`,
`live-contract/busy-and-late-control`.)

**Unreachable runtime:** a `dispose` mid-turn cancels first, so the stream
holds the cancelled answer (`turn_ended: aborted`) before `request dispose`,
`response exited` (code 143 from OAR's SIGTERM after `session/close`). When
Grok dies on its own (SIGKILL), the stream gets `response exited` with
`requestId ""` and code `null` and no turn end from the runtime
(`runtime_exited` for `awaitTurnEnd`); every later prompt/steer/queue/abort
is rejected `runtime exited` by the kernel's reachability gate (read off the
stream, not an adapter flag) and a later `dispose` is answered `accepted`.
(`live-contract/dispose-mid-turn`, `live-contract/kill-runtime`;
[test](../../tests/acp/acp-session.test.ts).)

### Events, history, and child sessions

**Mapped:** a basic one-word turn is 50 records: the handshake answers
`initialize`, `authenticate`, `session/new` (model view); then per prompt
`_x.ai/sessions/changed` (working), several `available_commands_update`
pushes, `session_summary_generated` + `session_info_update` (Grok titles the
session), token-level `agent_thought_chunk` and `agent_message_chunk` (each
with `_meta.eventId`, `promptId`, `totalTokens`, `chunkId`),
`response_completed`, `turn_completed`, `sessions/changed` (idle),
`prompt_complete`, and the `session/prompt` answer (`turn_ended` + `usage`).
`native` is present on every event and seqs are dense
(`live-contract/basic`). Views preserve text, reasoning, tool wire IDs, tool
boundaries, context snapshots, and model reports; detail strings truncate at
10,000 characters but `native` never does. Unknown updates are recorded with
no views. A tool the runtime never ended gets no synthetic end — the turn's
`turn_ended` view is the only closure.
[Projection](../../packages/oar/src/shared/acp/projection.ts).

**Two notification methods.** On the wire `session/update` carries only
standard kinds (`available_commands_update`, `session_info_update`,
`agent_thought_chunk`, `agent_message_chunk`, `user_message_chunk`,
`tool_call`, `tool_call_update`), for the root and for each child id alike.
`_x.ai/session_notification` is its vendor twin — same envelope
`{sessionId, update: {sessionUpdate: <kind>, …}}` — and is where every
non-standard kind travels: `model_changed`, `session_summary_generated`,
`tool_call_delta_chunk`, `pending_interaction`, `interaction_resolved`,
`response_completed` (per model call, snake_case usage), `turn_completed`
(per prompt, camelCase usage with `modelCalls` and `costUsdTicks`),
`last_turn_summary`, `background_tasks` (pushed by `session/resume`), and the
sub-agent lifecycle. This split matters because the ACP SDK (1.4.0) client
validates every `session/update` against a closed union of the standard kinds
*before* any handler runs — a vendor kind on that method would be dropped
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
Each is recorded verbatim with no views; an unlisted method is a frame OAR
never sees (`grok-wire-tap.ts` shows wire versus stream;
[wire-shape test](../../tests/acp/acp-grok-wire-shapes.test.ts)).

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
child's. The root's `tool_call_ended` output embeds the child's report plus a
`<subagent_meta>` block.

OAR keeps every frame regardless of session id: a foreign id becomes a
child-session record (envelope `sessionId` = the child's, `agentPath []`, a
node in `Session.graph()`), for `session/update` and vendor frames alike, so
the child's ledgers land under the child and the parent's `subagent_*`
lifecycle under the parent. A vendor frame naming a parent/child pair — in
either spelling (`parent_session_id`/`parentSessionId`) at either depth
(`acpLineageOf`, [records.ts](../../packages/oar/src/shared/acp/records.ts))
— links the graph `via: "tool_call"`; one child spawn yields two nodes and
one edge. A child whose lineage notification was not observed stays a node
without an edge; OAR never fabricates one. There is no child control handle.
(`live-contract/subagent`; [wire-shape
test](../../tests/acp/acp-grok-wire-shapes.test.ts) with fixture
[`fake-acp-grok.mjs`](../../tests/fixtures/fake-acp-grok.mjs).)

**Unsolicited response:** Grok has been seen sending, once per session, a
JSON-RPC *response* with `id: "skills-reload"` matching no request of OAR's
(the SDK logs "Got response to unknown request skills-reload"). It does not
reproduce under the wire tap, so its params are unrecorded; it does not reach
the stream.

**History:** the retained stream backs `subscribe(observer, cursor)` for the
life of the process — a mid-turn subscribe with `afterSeq` replays exactly the
retained records and continues live; a full replay equals `records()`
(`live-contract/cursor`). There is no native-history enumeration and no
rebuild after the process died.

### Models and instructions

Native model discovery uses `_x.ai/models/list`; model selection uses
`session/set_model`. [OAR listing](../../packages/oar/src/runtimes/grok/list-models.ts)
handles the extra result envelope and filters hidden/unselectable entries
(`grok-list-models.ts`). **Mapped:** open-time model selection applies
`session/set_model` after the session opens, and `model()` folds the runtime's
reports — `models.currentModelId` from `session/new`/`resume`, then the
`set_model` answer's `_meta.model` (the applied id, never the request). A
non-existent id is rejected `Invalid params`, so `session()` throws at open
(`live-contract/bad-model`). The runtime default model is not stable across
sessions: with no request from OAR, `session/new` has reported both
`grok-4.6` and `grok-4.5`; a `model_changed` vendor push precedes the answer
and names the same id. Public mid-session model and reasoning-effort setters
are **unexposed**. [Model read-back](../../packages/oar/src/shared/acp/model.ts),
[test](../../tests/acp/acp-session-model-usage.test.ts).

Grok's initialization extensions accept system-instruction configuration.
OAR maps `systemPrompt` to `_meta.systemPromptOverride` and
`appendSystemPrompt` to `_meta.rules` on `initialize`; these are Grok
mappings, not standard ACP fields.

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
a ledger missing either side is ignored rather than half-counted). Each
ledger is what THAT prompt billed, summed over every model call the prompt
caused, not a session total: repeated one-word turns bill about 16.8k input
each; a send-now steer's two answers carry two disjoint ledgers (the
cancelled prompt's one call, 16776/222, then the steering prompt's own two
calls, 34420/279 with `modelCalls: 2` — the re-issued tool round plus the
final answer), so summing both counts nothing twice; and a prompt that
spawned a child bills the child's calls inside its own ledger (53321/355,
`modelCalls: 4` = the parent's two and the child's two `response_completed`
frames, `input_tokens` + `cache_read_input_tokens` each, while the child's
own `turn_completed` reports 19280/96, `modelCalls: 2`). The adapter
therefore accumulates only the
root's prompt ledgers and stamps the running total on each answer's `usage`
view; the root's `usage()` already covers the child's spend. The child's own
ledgers — its `response_completed` per call, its `turn_completed`, and the
parent's `subagent_progress`/`subagent_finished` `tokens_used` — are recorded
verbatim (`native` only, child-envelope ones under the child's session id)
and deliberately NOT folded a second time. (`live-contract/multi-turn`,
`steer`, `subagent`; [wire-shape
test](../../tests/acp/acp-grok-wire-shapes.test.ts).)

Native [explicit compaction dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L2561-L2563)
exists through `x.ai/compact_conversation`; automatic compaction remains
native harness behavior. OAR has no typed compaction operation.

### Tools, MCP, and permissions

Native ACP supports terminal and permission reverse requests; vendor tools
and configured MCP integrations execute within the harness. **Mapped:** OAR's
[terminal host](../../packages/oar/src/shared/acp/terminal.ts) hosts
terminals, including Grok's full shell-line `command` compatibility. A tool
turn opens with `tool_call` `title: "run_terminal_command"` and `rawInput`
(the shell line), runs through `terminal/create|wait_for_exit|output|release`
reverse requests (four `toApp` records with `answered` responses, terminal
output payloads verbatim), and closes with a `tool_call_update` whose
`rawOutput` is `{type: "Bash", output: [<bytes>], output_for_prompt:
"exit: 0\n…"}` — a byte array, which the `tool_call_ended` view carries
JSON-encoded (`live-contract/tool-detail`). Under `--always-approve` no
`session/request_permission` arrives, though Grok still pushes
`pending_interaction`/`interaction_resolved` pairs; if one did, the
[client app](../../packages/oar/src/shared/acp/client-app.ts) selects
`allow_always`, then `allow_once`, otherwise `cancelled`, alongside the
launch/session yolo settings. Each reverse request is recorded as a `toApp`
request under the runtime's JSON-RPC id and OAR's reply as the `answered`
response. [Terminal tests](../../tests/acp/acp-terminal.test.ts) cover shell
compatibility, truncation, and cleanup.

There is no application approval callback, generic client-tool callback, or
per-session MCP configuration (all **unexposed**). Passing no MCP servers and
disabling client filesystem methods does not disable every vendor-configured
tool.

### Process ownership, release, installation, and account usage

Native ACP advertises session close. **Mapped:** OAR owns the spawned
process; disposal cancels active work, attempts `session/close` when
advertised (2-second deadline), kills its process, and disposes hosted
terminals. A terminal still pending `terminal/wait_for_exit` at disposal is
answered `{exitCode: null, signal: "SIGKILL"}` *after* the `exited` response
(the spec keeps late facts). Disposal does not delete the persistent native
session and supplies resource release, not detached execution or a lease
against other controllers. The environment overlay applies to the child
process and to hosted terminals.

Installation checks `OAR_GROK_BIN`, PATH, and the official script/npm layouts
(`$GROK_BIN_DIR`, `$GROK_HOME/bin`, `~/.grok/bin`), probing with
`grok agent stdio --help`. [Account usage](../../packages/oar/src/runtimes/grok/account-usage.ts)
separately opens a connection and queries `_x.ai/billing` (plus
`_x.ai/auth/info` for the email); account quota, prompt billing, and context
occupancy are distinct APIs and measurements.
[Installation](../../packages/oar/src/runtimes/grok/installation.ts).

## Verification and open gaps

[`experiments/live-contract.ts grok`](../../experiments/live-contract.ts)
covers every promise above on a real SuperGrok login through the public
Session API, from a scratch cwd under `/tmp` (yolo mode edits files), across
the thirteen scenarios cited by name; [`grok-wire-tap.ts`](../../experiments/grok-wire-tap.ts)
compares the raw wire with the stream (which frames reach records; two
notification methods; lineage shape; per-prompt ledgers). The battery's
voyage recorder can write a late record (the post-`exited` terminal answer
above) into the next scenario's log — a recorder hazard, not a stream one.

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

Open gaps: concurrent children; cancellation with background children
(`will_wake`, `task_backgrounded`, `task_completed`); usage across
compaction; concurrent same-ID controllers, cross-process live attachment
and load-fallback code effects; the `skills-reload` response's payload; the
[sym]-only vendor methods. Design should distinguish restoring context,
replaying observations, and adopting live execution; the Session OAR returns
does not imply all three.
