# Codex

Evidence baseline: OAR source as of 2026-09-11; native source pinned to
[`4f39251a`][native-source] (2026-08-22); the app-server guide is rolling
documentation. Live observations below come from **codex-cli 0.154.0**
(`gpt-5.3-codex-spark`, ChatGPT login, darwin) through
[`experiments/live-contract.ts codex`](../../experiments/live-contract.ts)
(13 scenarios, run 2026-09-11), from
[`experiments/codex-child-threads.ts`](../../experiments/codex-child-threads.ts)
on **0.149.0**, and from the probes (handshake, steering/abort,
model listing, resume/model readback) listed in the
[experiments index](../../experiments/README.md). Versions are evidence
baselines, not a support range; a claim that holds only on a named binary is
marked [env]. See the [runtime index](README.md) for evidence and status
conventions.

## Native concepts and calling interfaces

Codex owns the agent loop, tools, model context, persistence, and policy
enforcement. Its core execution model is **Thread → Turn → Item**. A request
acknowledgement, a streamed item, and a completed turn answer different questions.

| Concept | Native meaning |
|---|---|
| Thread | Persistent conversation identity, configuration, history, and loaded execution state. |
| Turn | An execution episode with native ID and terminal status; it may contain many model/tool steps. |
| Item | A typed message, reasoning block, tool invocation, compaction, collaboration operation, etc. Item IDs join lifecycle events and deltas. |
| Request / notification | RPC replies acknowledge operations; notifications report execution. Server-initiated requests require client replies. |
| Subagent | Collaboration refers to other threads and their states, with identities separate from the parent turn and its tool items. |

The native calling surfaces are related but expose different contracts:

| Surface | Calling model |
|---|---|
| CLI | Interactive terminal use and noninteractive `codex exec` execution. |
| TypeScript SDK | Wraps the CLI. `startThread()` / `resumeThread(id)` return a Thread; `run()` buffers a result and `runStreamed()` exposes events. |
| Python SDK | Exposes a `Codex` client, thread operations, runs, streaming, and workspace controls. |
| App-server | Bidirectional protocol for thread/turn control, notifications, and server-initiated interactions. **This is OAR's selected interface.** |

See the pinned [thread schema][thread-schema], [item schema][item-schema],
[TypeScript SDK][ts-sdk], [Python SDK][python-sdk], and the rolling
[app-server guide][guide]. SDK behavior must not be substituted for the
app-server contract merely because operation names resemble each other.

## High-level mapping to OAR

OAR starts one `codex app-server` process per Session, speaks the app-server's
own protocol version 2 over stdio, and exposes it as the
[record stream](../spec/README.md): every notification is one event record
(params verbatim in `native`, oar's reading in `views`), every control call is
a request record answered by the RPC reply, and codex's own `turn/completed`
is the turn's end. The adapter declares `capabilities: { steer: true, queue:
{ durable: true }, attribution: "nested" }`.

| Native concept or boundary | Current OAR mapping |
|---|---|
| Thread identity | `Session.id` is the native thread id; the `thread/start` / `thread/resume` reply is the open event record (`type` = the method), carrying the `model` view. Frames the app-server sends before that reply (notifications and server requests alike) are held in one queue and recorded ahead of it in wire order; the open event sits at the reply's own wire position, so frames codex writes after the reply (`thread/started`) follow it whatever the chunking. |
| Native turn | No OAR turn object. The turn starts at the `prompt` request record and ends at codex's `turn/completed` event (`turn_ended` view: `completed`; `interrupted` → aborted; any other status → failed, with the preceding `error` notification's detail appended). The native turn id rides every turn-scoped notification as `spanId` and is the precondition for steer/interrupt. |
| Items and notifications | One event per notification, nothing dropped: `item/agentMessage/delta` → `text_delta`; `rawResponseItem/completed` reasoning → `reasoning`; `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` items → `tool_call_started` / `tool_call_ended` with the item id as `callId`; `thread/tokenUsage/updated` → `usage`; everything else is an event with no views. |
| Control replies | The `turn/start`, `turn/steer`, `turn/interrupt` and `thread/queue/add` replies are the `accepted` / `rejected` responses to the prompt / steer / abort / queue requests, with the reply as `native` (the queue submission id is thereby retained). The response is recorded as the reply line is read, so it sits before notifications codex wrote after it. |
| Effective configuration | `model()` folds the `model` view of the open reply; most native configuration has no public mutator. |
| Server requests | Recorded as `toApp` request records (method and params verbatim, the server's own id), never answered: `approvalPolicy: never` means none are expected, and one that arrives stays a dangling request. |
| Native children | Notifications of another thread are child-session records (`sessionId` = that thread id, a `graph()` node); a collaboration item naming `receiverThreadIds` / `agentThreadId` adds a `tool_call` edge from the sender thread. The app-server delivers child-thread notifications on the parent's connection ([env] 0.149.0, 0.154.0); without an item naming the thread no edge is fabricated. |
| Process and observation lifetime | The Session owns its process; `dispose` is a request answered by the observed `exited` response (also recorded, pointing at no request, when the app-server dies on its own). The retained log backs the cursor for this process's lifetime; a resume starts a fresh stream at seq 0. |

Implementation: [session adapter][oar-session], [projection][oar-projection],
[kernel][oar-kernel], and [transport][oar-transport].

## Capability details

### Connection, session creation, and resume

OAR launches `codex app-server -c sandbox_mode="…" --listen stdio://` (the
override is described under tools and permissions), sends `initialize`
(`clientInfo: { name: "oar" }`, `capabilities: { experimentalApi: true }`),
then the `initialized` notification. Request ids correlate replies. New
sessions call `thread/start { cwd, model?, approvalPolicy: "never",
experimentalRawEvents: true, baseInstructions?, developerInstructions? }`;
OAR requires a returned thread id before constructing its Session and kills
the process otherwise.

The app-server talks before the thread exists: [env] 0.154.0 a
`remoteControl/status/changed { status: "disabled", serverName,
installationId, environmentId: null }` follows the `initialize` reply in every
run and is always seq 0; the `thread/start` open event is seq 1 and
`thread/started` (root `parentThreadId: null`) follows it. The client holds
such frames until the adapter's handlers exist and records them ahead of the
open event ([pre-open tests](../../tests/codex/codex-pre-open.test.ts)).
`thread/start` accepts an unknown model slug and reads it back (`model:
"oar-no-such-model-xyz"`, plus a `warning` "Model metadata … not found"); the
failure surfaces only at the first turn (see models). [Adapter][oar-session],
[transport][oar-transport],
[handshake probe](../../experiments/codex-handshake.ts).

**Resume.** The selected native call has this shape:

```text
thread/resume { threadId: savedThreadId, cwd, model? }
  → { thread: { id, turns, ... }, model, cwd, ...effectiveConfiguration }
```

It loads persisted conversation state or attaches to a thread already loaded
in that server. It does not submit a user prompt; that is `turn/start`. The
result includes effective configuration and history, with native options for
excluding or paging turns. Resume success is not turn completion, and returned
history is not replayed as live notifications. The pinned schema's
experimental history/path inputs are not exposed. [Resume schema][resume-schema].

**Mapped:** `codexRuntime.session(installation, { cwd, resume: savedSessionId,
model? })` sends `thread/resume { threadId, excludeTurns: true, cwd, model?,
approvalPolicy: "never", …instructions }`, waits for the reply, requires a
thread id, and checks an explicit `model` against the readback. The token is
a native thread id resolved against the selected executable's runtime
storage/configuration; it is not a portable transcript. The resumed session
has the same id and a fresh stream at seq 0 whose open event is the
`thread/resume` reply, preceded by what the app-server said while loading the
thread ([env] 0.154.0: `remoteControl/status/changed`, `warning`, four
`mcpServer/startupStatus/updated`, `thread/status/changed idle`; the open
event lands at seq 7), and it recalls the earlier transcript (live-contract
`resume`). Because `excludeTurns` is set, the history is not replayed into
the stream and no cursor from the previous process is valid; nothing restores
observer positions or a controller lease. After resume the first `turn/start`
is preceded by a `thread/tokenUsage/updated` carrying the PREVIOUS turn's id
and the thread's cumulative total, then `thread/goal/cleared` ([env]
0.154.0). Totals accumulate across processes, so `usage()` on a resumed
session includes earlier turns.

A thread with no completed turn has no persisted rollout to resume.
Missing/unloadable threads reject through RPC; OAR retains the error message
but drops structured RPC error data. A `thread/resume` on a connection already
subscribed to the loaded thread drops the `model` override and reports the old
model, so the adapter rejects a readback mismatch (killing the app-server it
started) rather than run silently on another model; the override applies on a
cold load, the normal case since every Session owns its own process.
Independent controllers resuming the same persisted identity are not
arbitrated by OAR. Resume sends no `experimentalRawEvents`, and sending it is
inert (see observation).
[Resume/model probe](../../experiments/session-resume-model.ts),
[resume probe](../../experiments/session-resume.ts),
[resume tests](../../tests/codex/codex-session-resume-model.test.ts),
[adapter][oar-session], [error handling][oar-transport].

### Prompt, steering, queueing, and abort

**Prompt (mapped):** native `turn/start { threadId, input }` returns
`{ turn: { id } }`; later notifications establish completion. `prompt(string)`
records a `prompt` request, sends one text input, and records the RPC reply as
the `accepted` response, or `rejected` with the RPC error message, `rejected:
codex turn/start returned no turn id`, or `rejected: busy` while a root turn
is active (including a queued turn codex started on its own). Completion is
codex's `turn/completed` with a `turn_ended` view, exactly one per prompt
(live-contract `multi-turn`). A basic one-word turn was 33 records with view
kinds `model, reasoning, text_delta, usage, turn_ended`, one `spanId`, dense
seqs, every event carrying `native`, and `dispose` answered `exited { code:
null }` (live-contract `basic`). No image/skill input, structured-output
schema, or per-turn configuration is exposed. [Adapter][oar-session].

**Steer (mapped, landing observed):** native `turn/steer { threadId,
expectedTurnId, input }` binds input to the expected active turn; OAR supplies
the retained native turn id. The `{ turnId }` reply is the `accepted` response
(delivery ownership, not model attention); every RPC error is `rejected` with
a reason prefixed `not_steerable:` (operational failures included), and with
no active turn the gate answers `not_steerable: no active turn`. A steer
accepted while the turn's first tool ran appeared as a `userMessage` item
inside the same turn and shaped its final text (`ALPHA BRAVO MANGO`), with one
`turn_ended` (live-contract `steer`;
[adapter probe](../../experiments/codex-session-adapter.ts)).

**Queue (mapped, `durable: true`):** native queue operations have submission
identities and inspection/editing methods. `queue()` calls `thread/queue/add
{ threadId, input, clientUserMessageId: <uuid> }` and keeps the reply
(`queuedSubmission { id, input, clientUserMessageId }`) as the accepted
response's `native`; inspection/editing are not exposed. Codex emits
`thread/queue/changed` at add and at drain, and the drained turn is a
spontaneous turn: `turn/started` … `turn/completed` with no prompt request of
its own, its `userMessage` item carrying `clientId` = the submitted
`clientUserMessageId` (live-contract `queue`,
[queue probe](../../experiments/session-queue.ts)). The adapter adopts such a
turn as busy. Evidence establishes the subsequent turn, not recovery of a
queued submission after process death; that half of the durability claim is
**unverified**. [Thread schema][thread-schema].

**Abort (mapped):** native `turn/interrupt { threadId, turnId }` targets an
execution; `turn/completed` reports whether the interrupt won the race.
`abort()` records an `abort` request; the interrupt reply (`{}`) is its
`accepted` response and an RPC error (the turn already finished) is a
`rejected` response with the runtime's message: a recorded race, not a
swallowed error. The outcome is `turn/completed`'s status: `interrupted` →
`aborted`. With nothing active, `abort()` is `rejected: no active turn`. The
reply is recorded after the frames codex wrote in the meantime (the raw
`function_call_output` `"Wall time: 2.2 seconds\naborted by user"`, a usage
update and rate limits), and `turn/completed { status: "interrupted", items:
[] }` follows; the interrupted `commandExecution` item gets no
`item/completed`, so its `tool_call_started` has no `tool_call_ended`
(live-contract `abort`). After a turn has ended: a second prompt during a
turn is `rejected: busy`, a late abort `rejected: no active turn`, a late
steer `rejected: not_steerable: no active turn` (live-contract
`busy-and-late-control`).
[Stream tests](../../tests/codex/codex-session-stream.test.ts).

**Dispose and unreachable runtime:** `dispose()` records a `dispose` request,
kills the Session's app-server and awaits its exit; the exit code is recorded
as the `exited` response (signal death: `code: null`). Active work is not
settled by oar: a dispose mid-tool ends with `tool_call_started`, `dispose`,
`exited { code: null }` and no `turn_ended`, so the exit is the turn end for
observers and `turnEndAfter` reads `failed: runtime exited` (live-contract
`dispose-mid-turn`). Dispose releases the process; it establishes no exclusive
control over persisted history. When the app-server dies on its own (SIGKILL
mid-tool) the stream gets `exited { code: null }` with `requestId: ""`; every
later prompt/steer/queue/abort is `rejected: runtime exited`, and a later
`dispose()` is answered `accepted`; nothing is left to release
(live-contract `kill-runtime`). Both reachability answers (`runtime exited` /
`session disposed`) are the shared kernel's, read off the stream before the
adapter's own gates (busy, no active turn) run; the adapter keeps no liveness
flag. [Kernel][oar-kernel],
[pre-open tests](../../tests/codex/codex-pre-open.test.ts).

### Observation, children, and history

**Mapped:** native thread read/list/fork operations expose stored state, and
resume can return history; OAR exposes none of those and does not hydrate the
stream from the resume result. Every notification enters the stream verbatim
(`native` is the params object) with a session-local `seq`, ingress
`receivedAt`, and the native turn id as `spanId`; `subscribe(observer,
{ sessionId, afterSeq })` replays the retained records of this process, then
continues live; a mid-turn subscribe's replay plus live delivery is
contiguous with the log, and a full replay equals `records()` (live-contract
`cursor`). There is no cross-process cursor, catch-up from codex's rollout, or
backpressure. Tool detail: a `commandExecution` item yields `tool_call_started`
with the command as input (`/bin/zsh -lc 'echo …'`) and `tool_call_ended` with
`exit <code>\n<aggregated output>`, same `callId` (the item id, `call_…`); the
raw `function_call` names `exec_command`; `item/commandExecution/outputDelta`
frames carry stdout with no view (live-contract `tool-detail`;
[item-detail tests](../../tests/codex/codex-item-detail.test.ts)). The guide
marks rollback deprecated; OAR does not expose it.

**Reasoning:** `thread/start` sends `experimentalRawEvents: true`; reasoning
views come from the `rawResponseItem/completed` frames it enables
(`item/started|completed` reasoning items carry no view). The generated
protocol schema (`codex app-server generate-json-schema`, [env] 0.154.0) lists
the flag on neither `ThreadStartParams` nor `ThreadResumeParams`, yet
`thread/start` with it yields raw frames: every turn opens with the raw
`message` items codex sent (developer skills/plugin instructions, the user
prompt), then reasoning / `function_call` / `function_call_output` / assistant
message items, while a resumed thread yields none, and sending the flag on
`thread/resume` is inert: a resumed stream shows only `item/started|completed`
reasoning with empty summary/content, so there are no `reasoning` views after
resume. On `gpt-5.3-codex-spark` every reasoning step is `item/started` +
`item/completed { type: "reasoning", summary: [], content: [] }` plus one raw
reasoning item with empty `summary` and an `encrypted_content` → `reasoning
{ kind: "redacted" }`; no plaintext reasoning appeared in any live run
(`reasoningEffort: "medium"`, `reasoningOutputTokens` > 0 in usage).
[Reasoning tests](../../tests/codex/codex-reasoning.test.ts),
[projection][oar-projection].

**Native children (nested):** the pinned `collabAgentToolCall` schema carries
`senderThreadId`, `receiverThreadIds`, and `agentsStates`; `subAgentActivity`
identifies a thread/path; the rolling guide instead documents `collabToolCall`
with different fields. Claude's `parent_tool_use_id` is not Codex's linkage.
OAR records notifications of other thread ids as child-session records
(`sessionId` is the child thread, a `graph()` node) and adds a `tool_call`
edge from the sender (`senderThreadId`, else the root) to each
`receiverThreadIds` / `agentThreadId` entry that is not the sender; the items
themselves are events with no views. Lineage (an edge) stays distinct from
observation (a node), and no edge is fabricated. `agentPath` stays `[]` on
every record: attribution is `nested` (child session ids), not agent paths.
On the wire, with `multi_agent` enabled ([env]; the item vocabulary differs
by build):

- The app-server delivers the child thread's notifications on the parent's
  connection; the projection derives the child session and exactly one
  root → child edge (0.149.0: 3/3 runs of `codex-child-threads.ts`; 0.154.0:
  live-contract `subagent`).
- No child `thread/started` is sent (the root's carries `parentThreadId:
  null`); the child first appears as `thread/status/changed` (idle → active →
  idle) with its own `threadId` (on 0.154.0 before the spawn item names it),
  so the graph node precedes the edge. The child then emits its own
  `warning`, `mcpServer/startupStatus/updated` ×4, `turn/started`, items,
  `rawResponseItem/completed` (raw events are on for the child),
  `thread/tokenUsage/updated` ×2, `turn/completed`.
- 0.149.0 emitted `subAgentActivity { kind: "started", agentThreadId:
  <child>, agentPath: "/root/<name>" }` (the edge source) plus
  `collabAgentToolCall { tool: "wait", status: "inProgress" → "completed",
  senderThreadId: <root>, receiverThreadIds: [] }`; the child emitted
  `subAgentActivity { kind: "interacted", agentThreadId: <root>, agentPath:
  "/root" }` once, filtered because it names the parent. 0.154.0 (Spark,
  `multi_agent` stable/on, `multi_agent_v2` off) emitted only
  `collabAgentToolCall` (`tool: "spawnAgent"` and `"wait"`, no
  `subAgentActivity`, no `collabToolCall`) with `senderThreadId` (root),
  `receiverThreadIds` (`[]` on the spawn `item/started`, the child id on its
  `item/completed` and on both `wait` frames), `agentsStates` keyed by child
  id (`pendingInit` → `completed` with the child's final message), `prompt`,
  `model`, `reasoningEffort`; the edge derives from the spawn completion and
  the `wait` frames repeat it (`graph()` holds one edge). Spark discovers the
  collaboration tools through a `tool_search_call` (namespace
  `multi_agent_v1`) before the raw `spawn_agent` / `wait_agent`
  `function_call` items.
- `thread/tokenUsage/updated` arrives for both threads, each cumulative for
  its own thread; the child's lands in the child session's records and is not
  aggregated into the root `usage()` (0.154.0: root 66290 in / 761 out after
  the turn, the child's cumulative 27317 kept apart).
- The child's `turn/completed` can precede the root's or never arrive; the
  root's own `turn/completed { status: "completed" }` came every time, with
  the root's `wait` item completing on the child's message. `awaitTurnEnd`
  and the `model` / `usage` / `contextUsage` folds therefore scope to the
  root session ([fold tests](../../tests/observe-folds.test.ts)).
- No `toApp` request arrived during a sub-agent turn. Control of child
  threads is not exposed.

[Item schema][item-schema], [guide][guide],
[child-thread probe](../../experiments/codex-child-threads.ts),
[replay tests](../../tests/replay/codex-projection.test.ts).

### Models, instructions, and context

**Mapped:** `model` on open selects the model for `thread/start` /
`thread/resume`; `model()` folds the `model` view of the open reply (the
runtime's readback, available at open), and a mismatch between an explicit
request and the readback fails the open. Opening with a model that does not
exist succeeds (the slug is read back, with a `warning`); the first
`turn/start` is accepted, then `thread/status/changed { type: "systemError" }`,
an `error` notification and `turn/completed { status: "failed" }` give
`turn_ended` failed with reason `failed: {"type":"error","status":400,
"error":{"type":"invalid_request_error","message":"The 'oar-no-such-model-xyz'
model is not supported when using Codex with a ChatGPT account."}}`, class
`invalid_request` (live-contract `bad-model`;
[readback probe](../../experiments/session-model-readback.ts)). Live
model/effort setters are **not exposed**.

Replacement instructions map to `baseInstructions` (replaces codex's base
prompt); append maps to `developerInstructions` (appended as a developer
message); `instructions` / `userInstructions` are silently ignored by
`thread/start`. Cwd and the process environment overlay are forwarded.
Requested and effective configuration remain distinct. [Adapter][oar-session],
[vendor test](../../sea-trial/vendor/codex.vendor.test.ts).

`listModels` runs `codex debug models` (stdout streamed: the payload is close
to 2 MB because every model embeds its instruction templates), not the
app-server's `model/list`; `slug` is identity, `display_name` presentation
only, and `visibility: "hide"` entries are dropped. Without credentials codex
still exits 0 with its built-in fallback list, so the lister never reports
`unauthenticated` and fallback entries can appear. [Model listing][oar-models],
[list probe](../../experiments/codex-list-models.ts).

**Context (mapped):** native usage separates `total`, `last`, and nullable
`modelContextWindow`. Each `thread/tokenUsage/updated` is an event with a
`usage` view: `context` = `last.totalTokens` (the last model call's input,
cached tokens included, plus its output: what the context holds once the
reply is in) against `modelContextWindow` with a rounded `percent`; `tokens`
= `total` input/output, the cumulative figure for the root thread.
`last.totalTokens` is codex's own occupancy reading:
`TokenUsage::tokens_in_context_window` returns `total_tokens` and the TUI
status card reads it off `last_token_usage` (`protocol/src/protocol.rs` at
[`4f39251a`][native-source]); codex's displayed percent additionally subtracts
a 12k `BASELINE_TOKENS`, which oar does not. When `last` is absent (older
builds) the occupancy is unknown: the cumulative input stands in as `tokens`
and the window and percent are null: the cumulative total is never read
against the window; when only the window is absent, `tokens` is `last`'s and
the window/percent are null. `contextUsage()` and `usage()` are folds over
these views, scoped to the root session.

The two figures diverge live: over three one-word turns `total.inputTokens`
grew 12661 → 28404 → 44166 while `last.totalTokens` stayed 12684 → 15749 →
15768 (`last.inputTokens` 12661 → 15743 → 15762) against a 121600 window.
The cumulative total is spend, not occupancy; `contextUsage()` reads about
11 % (13597 / 121600 after a basic turn) while `usage()` climbs per turn
(live-contract `multi-turn`, `basic`;
[replay test](../../tests/replay/codex-projection.test.ts)). One notification
arrives per model call, so a tool turn reports twice. Native manual compaction
(`thread/compact/start`) has no typed OAR operation; the vendor instruction
test defers compaction survival until it does. `account/rateLimits/updated`
follows each model call and has no view ([env] 0.154.0: `limitId: "codex"`,
`planType: "pro"`, primary 300-min and secondary 10080-min windows; the
notification reflects the thread model's own windows: a Spark thread
reported 0-4 % / 0-2 % while the account's main Codex weekly window stood at
88 %). [Thread schema][thread-schema], [usage projection][oar-context].

### Tools, permissions, and client callbacks

App-server supports native policy plus server requests for command/file/permission
decisions, user input, MCP elicitation, and experimental dynamic tools. OAR
records each server request as a `toApp` request record and never answers it:
it sets `approvalPolicy: never` and launches with `-c
sandbox_mode="danger-full-access"`; the launch override is the only seam that
governs codex's exec tool (`thread/start.sandboxMode` does not; pinned on a
real login). `OAR_CODEX_SANDBOX` pins a stricter mode, and
`OAR_CODEX_SANDBOX=inherit` skips the override so the user's own configuration
wins. Configurations requiring interactive settlement have no supported OAR
interaction path: the dangling request is the honest record
([stream tests](../../tests/codex/codex-session-stream.test.ts)); none arrived
in any live run.

OAR projects command execution, file changes, MCP calls, and web search, but
exposes no tool registration, dynamic-tool execution callback, MCP management,
or elicitation API. Runtime-owned tools (MCP servers, skills, plugins) still
come from native configuration. [Native interaction flows][approvals],
[transport][oar-transport], [projection][oar-projection].

### Process ownership, installation, and account usage

**Mapped:** OAR owns the spawned app-server; disposal kills it and waits for
the exit because the process may hold state (codex's sqlite runtime in
`CODEX_HOME`) that the next session needs released. This supplies resource
release, not detached execution or a lease against other controllers of the
persisted thread. The environment overlay applies to the child process.

Installation checks `OAR_CODEX_BIN`, then `codex` on PATH, then the macOS
desktop bundles (`ChatGPT.app` before the legacy `Codex.app`, system before
per-user installs), and requires `codex app-server --help` to succeed; a
codex without the app-server surface is unsupported. Account usage is a
separate reader on its own app-server process (`initialize`, `account/read`,
`account/rateLimits/read`, with `reauth_required` / `unsupported` outcomes and
rate-limit buckets merged as the codex TUI does); neither it nor installation
discovery is inferred from turn token totals. Login management is **not
exposed**.
[Installation](../../packages/oar/src/runtimes/codex/installation.ts),
[account usage](../../packages/oar/src/runtimes/codex/account-usage.ts).

## Harness fact matrix

This section answers the harness investigation questions for the one
interface OAR calls: app-server protocol v2 over stdio, one process per
Session. Every row labels its evidence: **source** is OAR adapter,
projection, transport, or test code at this revision; **source upstream** is
the codex-rs tree read at [`2151d3a5`][upstream-tree] (2026-09-12), newer
than the [`4f39251a`][native-source] pin used elsewhere on this page;
**observed** is a recorded run on a named binary version; **observed
by @Faye** is her app-server probe of 2026-09-12 ([message
e7ee9658][faye-probe]), run over the websocket transport against a local
Responses API mock with an isolated `CODEX_HOME`, so it speaks to server
behaviour, not to OAR's stdio path; **vendor** is native documentation that
no observation here has confirmed. Baselines: codex 0.154.0 (live contract,
13 scenarios) and 0.149.0 (child thread probe).

Two words that share a root name two different mechanisms. **Resume** is the
runtime rebuilding model context from its own persisted material; each
runtime has its own. **Replay** is OAR rebuilding an observer's event
sequence from OAR's own appended stream; it has one source and does not
depend on runtime resume. The "runtime side resume material" row describes
the former only.

### Matrix columns

| Column | Codex on OAR's path | Evidence |
|---|---|---|
| Session identity | The native thread id, a string returned in the `thread/start` or `thread/resume` reply and used as `Session.id`. Every record carries it as `sessionId`; notifications for a different `threadId` become child session records. It survives the OAR process because codex persists the thread as a rollout under `CODEX_HOME`, but only once a turn has completed. Before that the id lives only in the server's in memory loaded set: `thread/loaded/list` shows it, `thread/list` does not, the rollout `path` in the start reply does not exist on disk, and `thread/resume` fails `-32600 no rollout found` (observed by @Faye; matches the live contract observation on 0.154.0). | source [adapter][oar-session] lines 100 to 133; observed live contract resume scenario 0.154.0; observed by @Faye; source upstream [rollout crate][upstream-rollout] |
| Connection identity | Implicit: the subscription relation is the identity, and no addressable id exists. On OAR's path one spawned process is one stdio connection; no frame carries a connection id, and request ids are per client integers starting at 1. Over the websocket transport neither the upgrade response nor the `initialize` reply carries one either (observed by @Faye). Inside the server a `ConnectionId` exists per transport connection: `thread_state.rs` keeps `live_connections` and a per thread set of subscribed connection ids, `thread/start` and `thread/resume` add the calling connection to that set, `thread/unsubscribe` removes it, and a closed connection drops its pending request contexts. It is never written to the wire. The allowed values for this column are none, implicit, and explicit id; codex is implicit. | source [transport][oar-transport]; source upstream [thread state][upstream-thread-state], [outgoing messages][upstream-outgoing]; observed by @Faye |
| Transport cursor | Two kinds, filled separately. **Live stream cursor**, a position a reconnecting client hands back to receive the frames it missed: none. No notification carries a sequence field, `turnId` is a span label and a `thread/items/list` filter, and `thread/resume` on a running thread delivers history plus a fresh full copy of every later frame, not a continuation from a break (source upstream comment "sends the thread's history to the client and atomically subscribes for new updates"; observed by @Faye: after B resumes, A and B receive frame for frame identical method sequences). **History pagination cursor**: yes. `thread/resume` returns `itemsBackwardsCursor` and `turnsBackwardsCursor`, documented as opaque but observed as plaintext JSON `{ requestedThreadId, rolloutOrdinal, includeAnchor, scope }`, anchored on the append only rollout's ordinal, and consumed by `thread/items/list` and `thread/turns/list`. It pages the persisted log after the fact; it does not resume the live stream. OAR's `seq` is process local and is the only live cursor on this path. | source [kernel][oar-kernel] lines 168 to 183; source upstream [thread schema][upstream-thread-rs] lines 446 to 459; observed by @Faye (death boundary 待验证) |
| Event stream scope | Per process stdout on OAR's path: every notification the server emits on this connection is one event record, including notifications for child threads, which arrive on the parent's connection (observed 0.149.0 and 0.154.0). The server has two notification layers. A broadcast layer (`thread/started`, `thread/name/updated`, `thread/status/changed`) reaches every initialized connection, including one that never named the thread; a subscription layer (`turn/*`, `item/*`, deltas, `thread/tokenUsage/updated`) reaches only connections subscribed through `thread/start` or `thread/resume`, each receiving a full copy. `thread/unsubscribe` closes the subscription layer only. An observer connection therefore sees whether a thread is busy but not what it is doing. The server unloads a thread that is idle with no subscribers. With one stdio process OAR is always the sole subscriber, so it sees both layers merged. | source [projection][oar-projection]; observed [child thread probe](../../experiments/codex-child-threads.ts); source upstream [outgoing messages][upstream-outgoing] (`Broadcast` versus `ToConnection` envelopes); observed by @Faye |
| Runtime side resume material | The rollout file `rollout-<timestamp>-<threadId>.jsonl` under `CODEX_HOME/sessions`, indexed by a sqlite state database in the same home. It holds the items and events that `should_persist_response_item` and `should_persist_event_msg` admit: messages, reasoning, tool calls with their outputs, compaction markers, turn started, completed, aborted, and token counts. It does not hold app-server notifications as sent, deltas, server requests, or anything OAR appended. `thread/resume` with `excludeTurns: true` feeds it back to the model and replays nothing to OAR. Diagnostic reference only: OAR replays observers from its own appended stream, never from this file. | source upstream [persistence policy][upstream-policy]; source adapter line 103; observed [resume section](#connection-session-creation-and-resume) |
| Vendor claim versus evidence | Confirmed by observation on 0.154.0: resume continuity with `excludeTurns`, steer, queue, interrupt, dispose mid turn, child notifications on the parent connection, `exited` after kill. Vendor only: websocket and unix socket transports, `codex app-server proxy`, the app-server daemon, Codex Cloud `history` resume, `ephemeral` threads, ingress overload error `-32001`. Unverified either way: two controllers on one thread, queue durability across process death, resumed reasoning content, compaction frames, what happens when a recorded server request is never answered. | this page, [open gaps](#verification-and-open-gaps); vendor [app-server README][upstream-readme] |

### Eight dimensions

1. **Entry.** `codex app-server -c sandbox_mode="danger-full-access"
   --listen stdio://` (`OAR_CODEX_SANDBOX` selects another mode, `inherit`
   skips the override), then `initialize` with `clientInfo { name: "oar" }`
   and `capabilities { experimentalApi: true }`, `initialized`, and
   `thread/start { cwd, model?, approvalPolicy: "never",
   experimentalRawEvents: true, baseInstructions?, developerInstructions? }`
   or `thread/resume { threadId, excludeTurns: true, ... }`. A model readback
   that differs from the request kills the process and throws. Not on OAR's
   path although present upstream: `--listen ws://`, `--listen unix://`,
   `codex app-server daemon`, `codex app-server proxy`, `thread/fork`,
   `ephemeral`, `thread/resume { path }` and `{ history }`. Source:
   [adapter][oar-session] lines 54 to 133; vendor README.
2. **Session and state storage.** Thread identity, rollout, and the sqlite
   index are codex's, under `CODEX_HOME`; OAR's record stream is process
   memory behind `records()` and is gone with the process. OAR owns no
   storage. `dispose` kills and awaits exit because the sqlite lock in
   `CODEX_HOME` must be released before the next Session. Source: adapter
   line 293, [kernel][oar-kernel]; source upstream rollout crate.
3. **Event model.** Every JSON-RPC notification is one event record whose
   `type` is the method, whose `native` is the params verbatim, and whose
   `spanId` is the `turnId` when present. Server requests (frames with both
   `id` and `method`) are recorded as events plus a `toApp` request nobody
   answers. Frames read before the open reply are held in wire order and
   recorded ahead of the open event (`remoteControl/status/changed` at seq 0
   on 0.154.0). Deltas arrive because `experimentalRawEvents` is on. A turn
   is the span from `turn/started` to `turn/completed`, whose `turn.status`
   (`completed`, `interrupted`, `failed`, `inProgress`) settles the OAR
   outcome, with a preceding `error` notification carried into the failed
   reason. Source: [projection][oar-projection] lines 39 to 62 and 150 to
   200, [transport][oar-transport]; observed [stream tests](../../tests/codex/codex-session-stream.test.ts).
4. **Ownership and identity.** The spawning OAR process owns the child.
   Records carry `sessionId` and `agentPath`; a notification whose
   `threadId` differs from the root becomes a child record, and collab
   items yield `tool_call` edges. There is no lease: two OAR Sessions
   resuming one thread id are not arbitrated by codex (observed). Source:
   adapter line 154, projection.
5. **Capability honesty.** Declared `{ steer: true, queue: { durable: true },
   attribution: "nested" }`. Steer is `turn/steer { expectedTurnId }` and
   queue is `thread/queue/add { clientUserMessageId }`, both held by codex,
   which is why queue is declared durable; whether a queued item survives
   process death is an open gap, so that flag is declared on the strength of
   the server holding it, not of observation across death. Source: adapter
   lines 246 to 272; [open gaps](#verification-and-open-gaps).
6. **Deployment and lifecycle.** Local subprocess only. Process exit is an
   `exited` response carrying the exit code: answering `dispose` when OAR
   caused it, with `requestId ""` when codex died on its own (code 137 after
   an external kill). Every pending request is rejected `app-server exited`;
   every later control is rejected `runtime exited`; `awaitTurnEnd` fails
   `runtime_exited`. No runtime frame announces death. Hosted forms upstream
   (daemon with `enable-remote-control`, unix socket control plane, proxy)
   are vendor only here. Source: [pre-open tests](../../tests/codex/codex-pre-open.test.ts)
   line 137, stream tests, transport; vendor [daemon README][upstream-daemon].
7. **Tools and permissions.** `approvalPolicy: "never"` and a full access
   sandbox, so no approval request is expected; one that arrives is recorded
   and left dangling. `item/started` on a tool item becomes
   `tool_call_started` with `callId`, `tool`, `input`; `item/completed`
   becomes `tool_call_ended` with `callId` and an `output` string built by
   `item-detail.ts`. Source: projection lines 72 to 82,
   [item detail](../../packages/oar/src/runtimes/codex/item-detail.ts).
8. **Extension points.** MCP servers, skills, apps, collab agents, and
   dynamic tools exist natively; OAR passes none of them. On the wire OAR
   uses `turn/start`, `turn/steer`, `thread/queue/add`, `turn/interrupt`,
   and the model list. Source: adapter lines 227 to 272; vendor README.

### Six questions

1. **Is the native session id stable across a host restart, and can it be
   reopened?** Yes: a new process with `thread/resume { threadId }` keeps
   the id and the model recalls earlier turns (observed, live contract).
   Reopening needs the rollout under the active `CODEX_HOME`, and only
   threads with a completed turn have one. Resuming on a connection already
   subscribed to that thread silently drops the model override (observed).
   Upstream also accepts a rollout `path` and a Codex Cloud `history`
   (vendor).
2. **Does the runtime log keep every frame or only turn snapshots?**
   Neither. The rollout is a filtered item log: the persistence policy
   admits selected response items and selected core events, one line each,
   and rejects the rest. It never holds app-server notifications as they
   were sent, so `item/started`, deltas, `thread/tokenUsage/updated`, server
   requests, and OAR's own requests and rejections are absent by
   construction. Source upstream [policy][upstream-policy].
3. **Is a stream rebuilt from that log isomorphic to the original?** No.
   Absent: every OAR request and response record, `seq`, the pre-open
   frames, every delta, every server request. Recoverable: message content,
   tool calls with outputs and status, turn boundaries with status, token
   counts. A rebuild is a subset with a different envelope.
4. **Can a second observer attach to the same session?** On OAR's stream,
   yes and without limit: `subscribe` with a cursor replays retained
   records after `afterSeq`, then continues live (source, kernel lines 168
   to 183). At the runtime there is no second reader of one stdio process.
   On a shared server a second connection that calls `thread/resume`
   becomes a second subscriber and from then on receives its own full copy
   of every content frame; a connection that never subscribes receives
   only the broadcast layer (observed by @Faye). Neither path gives the
   late joiner the frames emitted before it subscribed, other than through
   the history pages.
5. **Is there a recognizable last frame on process death, and what does the
   log say about an in flight tool call?** No runtime frame. The last record
   is OAR's `exited` response with `requestId ""` (source, pre-open test).
   The stream then holds a `tool_call_started` with no `tool_call_ended`,
   and the child `turn/completed` may never arrive. Whether the rollout
   holds the tool call without its output in that case, and where the
   history cursor points after a kill, is 待验证 by @Faye's death boundary
   probe.
6. **Do hosted forms report environment lifecycle events?** Not on OAR's
   path. Upstream, a daemon or unix socket server outlives any one client
   and unloads idle unsubscribed threads; `thread/status/changed` is
   broadcast to every connection, so thread activity is visible to
   observers, but whether a client is told about an unload, or about a peer
   connection closing, is 待验证 (Faye's death boundary probe and the
   daemon and proxy paths are still open).

### Tool call outcome reporting

Codex reports the outcome of every tool item, and OAR already holds it in
`native`. `commandExecution` carries `status` (`completed`, `failed`,
`declined`, `inProgress`) and `exitCode`; `fileChange` carries `status`
(same set); `mcpToolCall`, `dynamicToolCall`, and `collabAgentToolCall`
carry `status` (`completed`, `failed`, `inProgress`), and `mcpToolCall`
adds `error { message }`. Source upstream [item schema][upstream-item].
Today `item-detail.ts` flattens these into the `output` string (`exit N`,
the status word, or `error: <message>`), so the `result` field proposed for
`tool_call_ended` is derivable from data OAR holds today: `failed` or
`declined` maps to `failed`, `completed` to `ok`, and a missing status means
not reported. A `webSearch` item has results but no status.

## Verification and open gaps

[`experiments/live-contract.ts codex`](../../experiments/live-contract.ts)
covers every promise above on a real login, one voyage log per scenario:
basic, multi-turn, tool-detail, busy-and-late-control, steer, queue, abort,
dispose-mid-turn, cursor, resume, subagent, kill-runtime, bad-model. The
[experiments index](../../experiments/README.md) lists the further probes
(handshake; adapter steer/abort/busy; resume; resume with a model switch;
queue; model listing; model readback; child threads). Unit and replay tests
pin: the notification → record projection, child-thread attribution, collab
edges, the error-detail fold and the context/usage split
([replay](../../tests/replay/codex-projection.test.ts)); that a child
session's turn end and usage never satisfy the root folds
([folds](../../tests/observe-folds.test.ts)); resume parameters and model
mismatch ([resume](../../tests/codex/codex-session-resume-model.test.ts));
the stream shape: request/response ordering, busy, steer, queue and abort
replies, a refused interrupt, an unanswered server request, an unrequested
exit ([stream](../../tests/codex/codex-session-stream.test.ts)); pre-open
ordering, the open event ahead of a same-chunk `thread/started`, and control
after an unrequested death ([pre-open](../../tests/codex/codex-pre-open.test.ts));
item detail and reasoning classification. [Vendor
tests](../../sea-trial/vendor/codex.vendor.test.ts) use the real app-server
with a scripted provider for tools, errors, instructions, usage shape and
verbatim stream order. [CI](../../.github/workflows/ci.yml) runs that backend
on three operating systems with an unpinned CLI; configuration does not prove
a release passed.

Open gaps:

- Compaction: the per-call context reading is verified; context after native
  compaction and instruction survival through it are not, and
  `thread/compact/start` is unreachable through the Session API.
- Resumed reasoning visibility: blocked because raw events cannot be
  enabled on `thread/resume`, so a resumed session has no `reasoning` views.
- Queue durability across process death: only the drained subsequent turn is
  verified.
- Server requests are recorded, never answered; no configuration requiring
  approval, user input or elicitation has been exercised.
- Child threads: delivery and identity are [env] on 0.149.0 / 0.154.0 with
  differing item vocabularies; control of child threads is not exposed; a
  child `turn/completed` that never arrives is observed but unexplained.
- Missing/unloadable thread ids on resume are pinned only by the fake-process
  path; concurrent controllers of one thread are not arbitrated.

Keep these gaps separate from implemented methods and from spec guarantees not
yet verified live.

[native-source]: https://github.com/openai/codex/tree/4f39251a010a8bd7d692d25fb33832ff06f1635a
[thread-schema]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
[item-schema]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/app-server-protocol/src/protocol/v2/item.rs
[resume-schema]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L332-L438
[ts-sdk]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/sdk/typescript/README.md
[python-sdk]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/sdk/python/README.md
[guide]: https://learn.chatgpt.com/docs/app-server
[approvals]: https://learn.chatgpt.com/docs/app-server#approvals
[oar-session]: ../../packages/oar/src/runtimes/codex/session.ts
[oar-projection]: ../../packages/oar/src/runtimes/codex/projection.ts
[oar-kernel]: ../../packages/oar/src/shared/session-kernel.ts
[oar-transport]: ../../packages/oar/src/runtimes/codex/app-server-client.ts
[oar-context]: ../../packages/oar/src/runtimes/codex/projection.ts
[oar-models]: ../../packages/oar/src/runtimes/codex/list-models.ts
[upstream-tree]: https://github.com/openai/codex/tree/2151d3a5
[upstream-readme]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/app-server/README.md
[upstream-daemon]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/app-server-daemon/README.md
[upstream-thread-state]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/app-server/src/thread_state.rs
[upstream-outgoing]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/app-server/src/outgoing_message.rs
[upstream-rollout]: https://github.com/openai/codex/tree/2151d3a5/codex-rs/rollout/src
[upstream-policy]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/rollout/src/policy.rs
[upstream-item]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/app-server-protocol/src/protocol/v2/item.rs
[upstream-thread-rs]: https://github.com/openai/codex/blob/2151d3a5/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
[faye-probe]: raft://harness-investigation/5769c3d4/e7ee9658
