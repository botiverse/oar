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
| Thread identity | `Session.id` is the native thread id; the `thread/start` / `thread/resume` reply is the open event record (`type` = the method), carrying the `model` view. Frames the app-server sends before that reply — notifications and server requests alike — are held in one queue and recorded ahead of it in wire order; the open event sits at the reply's own wire position, so frames codex writes after the reply (`thread/started`) follow it whatever the chunking. |
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
and the thread's cumulative total, then `thread/goal/cleared` ([env] 0.154.0)
— totals accumulate across processes, so `usage()` on a resumed session
includes earlier turns.

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
the `accepted` response — or `rejected` with the RPC error message, `rejected:
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
— delivery ownership, not model attention; every RPC error is `rejected` with
a reason prefixed `not_steerable:` (operational failures included), and with
no active turn the gate answers `not_steerable: no active turn`. A steer
accepted while the turn's first tool ran appeared as a `userMessage` item
inside the same turn and shaped its final text (`ALPHA BRAVO MANGO`), with one
`turn_ended` (live-contract `steer`;
[adapter probe](../../experiments/codex-session-adapter.ts)).

**Queue (mapped, `durable: true`):** native queue operations have submission
identities and inspection/editing methods. `queue()` calls `thread/queue/add
{ threadId, input, clientUserMessageId: <uuid> }` and keeps the reply —
`queuedSubmission { id, input, clientUserMessageId }` — as the accepted
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
`rejected` response with the runtime's message — a recorded race, not a
swallowed error. The outcome is `turn/completed`'s status: `interrupted` →
`aborted`. With nothing active, `abort()` is `rejected: no active turn`. The
reply is recorded after the frames codex wrote in the meantime — the raw
`function_call_output` `"Wall time: 2.2 seconds\naborted by user"`, a usage
update and rate limits — and `turn/completed { status: "interrupted", items:
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
`dispose()` is answered `accepted` — nothing is left to release
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
continues live — a mid-turn subscribe's replay plus live delivery is
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
`thread/start` with it yields raw frames — every turn opens with the raw
`message` items codex sent (developer skills/plugin instructions, the user
prompt), then reasoning / `function_call` / `function_call_output` / assistant
message items — while a resumed thread yields none, and sending the flag on
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
  idle) with its own `threadId` — on 0.154.0 before the spawn item names it,
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
  `collabAgentToolCall` — `tool: "spawnAgent"` and `"wait"`, no
  `subAgentActivity`, no `collabToolCall` — with `senderThreadId` (root),
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
`thread/resume`; `model()` folds the `model` view of the open reply — the
runtime's readback, available at open — and a mismatch between an explicit
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
cached tokens included, plus its output — what the context holds once the
reply is in) against `modelContextWindow` with a rounded `percent`; `tokens`
= `total` input/output, the cumulative figure for the root thread.
`last.totalTokens` is codex's own occupancy reading:
`TokenUsage::tokens_in_context_window` returns `total_tokens` and the TUI
status card reads it off `last_token_usage` (`protocol/src/protocol.rs` at
[`4f39251a`][native-source]); codex's displayed percent additionally subtracts
a 12k `BASELINE_TOKENS`, which oar does not. When `last` is absent (older
builds) the occupancy is unknown: the cumulative input stands in as `tokens`
and the window and percent are null — the cumulative total is never read
against the window; when only the window is absent, `tokens` is `last`'s and
the window/percent are null. `contextUsage()` and `usage()` are folds over
these views, scoped to the root session.

The two figures diverge live: over three one-word turns `total.inputTokens`
grew 12661 → 28404 → 44166 while `last.totalTokens` stayed 12684 → 15749 →
15768 (`last.inputTokens` 12661 → 15743 → 15762) against a 121600 window —
the cumulative total is spend, not occupancy; `contextUsage()` reads about
11 % (13597 / 121600 after a basic turn) while `usage()` climbs per turn
(live-contract `multi-turn`, `basic`;
[replay test](../../tests/replay/codex-projection.test.ts)). One notification
arrives per model call, so a tool turn reports twice. Native manual compaction
(`thread/compact/start`) has no typed OAR operation; the vendor instruction
test defers compaction survival until it does. `account/rateLimits/updated`
follows each model call and has no view ([env] 0.154.0: `limitId: "codex"`,
`planType: "pro"`, primary 300-min and secondary 10080-min windows; the
notification reflects the thread model's own windows — a Spark thread
reported 0-4 % / 0-2 % while the account's main Codex weekly window stood at
88 %). [Thread schema][thread-schema], [usage projection][oar-context].

### Tools, permissions, and client callbacks

App-server supports native policy plus server requests for command/file/permission
decisions, user input, MCP elicitation, and experimental dynamic tools. OAR
records each server request as a `toApp` request record and never answers it:
it sets `approvalPolicy: never` and launches with `-c
sandbox_mode="danger-full-access"` — the launch override is the only seam that
governs codex's exec tool (`thread/start.sandboxMode` does not; pinned on a
real login). `OAR_CODEX_SANDBOX` pins a stricter mode, and
`OAR_CODEX_SANDBOX=inherit` skips the override so the user's own configuration
wins. Configurations requiring interactive settlement have no supported OAR
interaction path — the dangling request is the honest record
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
per-user installs), and requires `codex app-server --help` to succeed — a
codex without the app-server surface is unsupported. Account usage is a
separate reader on its own app-server process (`initialize`, `account/read`,
`account/rateLimits/read`, with `reauth_required` / `unsupported` outcomes and
rate-limit buckets merged as the codex TUI does); neither it nor installation
discovery is inferred from turn token totals. Login management is **not
exposed**.
[Installation](../../packages/oar/src/runtimes/codex/installation.ts),
[account usage](../../packages/oar/src/runtimes/codex/account-usage.ts).

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
the stream shape — request/response ordering, busy, steer, queue and abort
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
- Resumed reasoning visibility: blocked — raw events cannot be enabled on
  `thread/resume`, so a resumed session has no `reasoning` views.
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
