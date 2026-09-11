# Codex runtime

Reviewed **2026-09-08**, against OAR `9b102d0` and native source
[`4f39251a`][native-source]. Native documentation and recorded probes have
different version baselines; see [evidence and verification](#evidence-and-verification).

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

OAR starts one app-server process per Session, using v2 over stdio, and
exposes it as the [v2 record stream](../spec/README.md): every app-server
notification is one event record (params verbatim in `native`, oar's reading
in `views`), every control call is a request record answered by the RPC
reply, and the runtime's own `turn/completed` is the turn's end. The adapter
declares `capabilities: { steer: true, queue: { durable: true }, attribution:
"nested" }`.

| Native concept or boundary | Current OAR mapping |
|---|---|
| Thread identity | `Session.id` is the returned native thread ID; the `thread/start` / `thread/resume` reply is the first event record, carrying the `model` view. |
| Native turn | No OAR turn object. The turn starts at the `prompt` request record and ends at codex's `turn/completed` event (`turn_ended` view: completed / interrupted→aborted / failed with the `error` notification's detail). The native turn id rides every turn-scoped notification as `spanId` and is the precondition for steer/interrupt. |
| Items and notifications | One event per notification, nothing dropped: `item/agentMessage/delta` → `text_delta`; `rawResponseItem/completed` reasoning → `reasoning`; tool items → `tool_call_started` / `tool_call_ended` with the item id as `callId`; `thread/tokenUsage/updated` → `usage` (cumulative `total`); everything else is an event with no views. |
| Control replies | `turn/start`, `turn/steer`, `turn/interrupt`, `thread/queue/add` replies are the `accepted` / `rejected` responses to the prompt / steer / abort / queue requests, with the reply as `native` (the queue submission id is thereby retained). The reply is recorded in stream order, before notifications codex wrote after it. |
| Effective configuration | `model()` is a fold over `model` views (the open reply); most native configuration has no public mutator. |
| Server requests | Recorded as `toApp` request records (method and params verbatim, the server's id). Never answered — `approvalPolicy: never` means none are expected; one that arrives stays a dangling request. |
| Native children | Notifications of another thread are child-session records (`sessionId` = that thread id, `graph()` node). A `collabAgentToolCall` / `collabToolCall` / `subAgentActivity` item naming `receiverThreadIds` / `agentThreadId` adds a `tool_call` edge from the sender thread. Whether the app-server delivers other threads' notifications on this connection is **unverified** live; without an item naming the thread, no edge is fabricated. |
| Process and observation lifetime | Session owns its process; `dispose` is a request answered by the observed `exited` response (also recorded, pointing at no request, when the app-server dies on its own). The retained log backs the cursor for this process's lifetime; a resume starts a fresh stream at seq 0. |

Implementation: [session adapter][oar-session], [projection][oar-projection],
[kernel][oar-kernel], and [transport][oar-transport].

## Capability details

### Connection and session creation

OAR launches `codex app-server --listen stdio://` with configuration overrides,
sends `initialize` with experimental API capability, then `initialized`.
Request IDs correlate replies. New sessions use `thread/start` with cwd,
optional model/instructions, and `approvalPolicy: never`. OAR requires a
returned thread ID before constructing its Session. [Adapter][oar-session].

### Resume

The selected native call has this shape (method/parameter excerpt):

```text
thread/resume { threadId: savedThreadId, cwd, model? }
  → { thread: { id, turns, ... }, model, cwd, ...effectiveConfiguration }
```

It loads persisted conversation state or attaches to a thread already loaded in
that server. It does not submit a user prompt; that is `turn/start`. The result
includes effective configuration and history, with native options for excluding
or paging turns. Resume success is not turn completion, and returned history is
not replayed as live notifications. The pinned schema also has experimental
history/path inputs that OAR does not expose. [Resume schema][resume-schema].

For OAR, call `codexRuntime.session(installation, { cwd, resume: savedSessionId })`,
optionally supplying `model`. The ID is resolved against the selected
executable's runtime storage/configuration; it is not a portable transcript.
OAR waits for the resume RPC, requires a returned thread ID, validates an explicit
model against native readback, and creates a fresh record stream whose first
event is the `thread/resume` reply. It passes `excludeTurns: true`, so the
returned history is not replayed into the stream and no cursor from the
previous process is valid; nothing restores observer positions or a controller
lease.

The recorded empty-thread probe had no persisted rollout before its first turn.
Missing/unloadable threads reject through RPC; OAR retains error messages but
drops structured RPC error data. Loaded threads can ignore configuration
overrides, so OAR rejects a returned model mismatch. Independent controllers
resuming the same persisted identity are not arbitrated by OAR.
[Resume/model probe](../../experiments/session-resume-model.ts),
[adapter][oar-session], [error handling][oar-transport].

### Prompt submission and turn completion

Native `turn/start { threadId, input: [...] }` returns a Turn with native ID;
later notifications establish completion. OAR `prompt(string)` records a
`prompt` request, sends one text input, and records the RPC reply as the
`accepted` response (or `rejected` with the RPC error, or `rejected: busy`
while a root turn is active — including a queued turn codex started on its
own). Completion is codex's `turn/completed` event with a `turn_ended` view.
OAR exposes no image/skill input, structured-output schema, or per-turn
configuration. [Adapter][oar-session].

### Steering and future input

Native `turn/steer { threadId, expectedTurnId, input }` binds input to the
expected active turn. OAR retains the native ID for this request. The
`accepted` response promises delivery ownership, not model attention; all RPC
errors become a `rejected` response whose reason starts with `not_steerable:`,
including potentially operational failures.

Native queue operations also have submission identities and inspection/editing
methods. OAR `queue()` uses `thread/queue/add`, declares `queue: { durable:
true }`, and keeps the reply (submission ID included) as the accepted
response's `native`. It exposes no queue inspection/editing. A drained turn
runs as a spontaneous turn: `turn/started` … `turn/completed` events with no
prompt request of their own. Existing tests establish a subsequent turn, not
recovery after process death; that durability claim still needs targeted
evidence. [Thread schema][thread-schema], [adapter][oar-session].

### Cancellation and resource release

Native `turn/interrupt { threadId, turnId }` targets an execution. Completion
reports whether interruption won the race. OAR `abort()` records an `abort`
request; the interrupt reply is its `accepted` response and an RPC error (the
turn already finished) is a `rejected` response with the runtime's message —
the late abort is a recorded race, not a swallowed error. The outcome is
`turn/completed`'s status. `abort()` when nothing is active is `rejected: no
active turn`.

`dispose()` records a `dispose` request, kills the Session's app-server, and
awaits exit; the exit code is recorded as the `exited` response. Active work
is not settled by oar — if codex reports nothing before dying, the turn has
no `turn_ended` and consumers see the `exited` response instead. That releases
its process; it does not establish exclusive control over persisted history.
[Adapter][oar-session].

### Observation, history, and branching

Native thread read/list/fork operations expose stored state; resume can return
history. OAR exposes none of those history/branch operations and does not
hydrate the stream from the resume result. Every notification the app-server
sends on the connection enters the stream verbatim (`native` is the params
object) with a session-local `seq`, ingress `receivedAt`, and the native turn
id as `spanId`; `subscribe(observer, { sessionId, afterSeq })` replays the
retained records of this process, then continues live. There is no
cross-process cursor, catch-up from codex's rollout, or backpressure.

Starting enables `experimentalRawEvents` for reasoning classification; resuming
does not send that flag. Reasoning views therefore depend on that flag; the
`rawResponseItem/completed` frames themselves are recorded either way. The
current guide also marks rollback deprecated; OAR does not expose it.
[Guide][guide], [adapter][oar-session], [projection][oar-projection].

### Native child agents

The pinned `collabAgentToolCall` schema carries `senderThreadId`,
`receiverThreadIds`, and `agentsStates`; `subAgentActivity` identifies a
thread/path. The rolling guide instead documents `collabToolCall` with different
fields, requiring versioned evidence. Claude's `parent_tool_use_id` is not
Codex's linkage.

OAR records notifications of other thread IDs as child-session records
(`sessionId` is the child thread, added to `graph()` as a node) and adds a
`tool_call` graph edge from the sender thread when a collaboration item names
`receiverThreadIds` or `agentThreadId`; the items themselves are events with
no views. This distinguishes lineage (an edge) from mere observation (a node)
and never fabricates an edge. It is pinned only against fixtures: whether the
app-server delivers child-thread notifications on the parent's connection, and
which field spelling the running binary uses, remain **unverified** live.
Control of child threads is not exposed. [Item schema][item-schema],
[guide][guide], [projection][oar-projection].

### Permissions, tools, and client callbacks

App-server supports native policy plus server requests for command/file/permission
decisions, user input, MCP elicitation, and experimental dynamic tools. OAR
records each server request as a `toApp` request record (method and params
verbatim, the server's own id) and never answers it: it sets `approvalPolicy:
never` and defaults the launch sandbox to `danger-full-access`;
`OAR_CODEX_SANDBOX` can override or inherit configuration. Configurations
requiring interactive settlement have no supported OAR interaction path — the
dangling request is the honest record of that.

OAR projects command execution, file changes, MCP calls, and web search, but
exposes no tool registration, dynamic-tool execution callback, MCP management, or
elicitation API. Runtime-owned tools can still come from native configuration.
[Native interaction flows][approvals], [transport][oar-transport],
[projection][oar-projection].

### Models, instructions, and environment

OAR supports initial/resume model selection and native readback. Replacement
instructions map to `baseInstructions`; append maps to `developerInstructions`.
Cwd and process environment are forwarded. There is no live model/effort setter.

The separate `listModels` capability uses `codex debug models`, not the
app-server's `model/list`; unauthenticated fallback entries can still appear.
Requested configuration and effective configuration remain distinct.
[Adapter][oar-session], [model listing][oar-models],
[resume probe](../../experiments/session-resume-model.ts).

### Context, compaction, and account usage

Native usage separates `total`, `last`, and nullable `modelContextWindow`.
Each `thread/tokenUsage/updated` notification is an event with a `usage` view:
`context.tokens` = `total.inputTokens` (null window/percent) and `tokens` =
`total` input/output, taken as the cumulative figure for the root agent.
`contextUsage()` and `usage()` are folds over those views. The cumulative
input value is **unverified as current context occupancy**; the existing test
checks shape rather than the multi-step interpretation. Native manual
compaction has no typed OAR operation.

Installation discovery and credentialed account quota are separate OAR
capabilities; neither is inferred from turn token totals.
[Thread schema][thread-schema], [context calculation][oar-context],
[installation](../../packages/oar/src/runtimes/codex/installation.ts),
[account usage](../../packages/oar/src/runtimes/codex/account-usage.ts).

## Evidence and verification

Native source is pinned to `4f39251a` (2026-08-22); the official app-server guide
is rolling documentation. [Recorded probes](../../experiments/README.md) used
handshake `0.144.6`, steering/abort `0.148.0`, model listing `0.149.0`, and
resume/model readback `0.153.4` on 2026-09-05. These are evidence baselines, not
a supported version range. This review ran no runtime tests or model calls.

[Replay tests](../../tests/replay/codex-projection.test.ts) check the
notification → record projection, child-thread attribution and collab edges;
[fake-process tests](../../tests/codex/) check resume parameters/model
mismatch and the stream shape (request/response ordering, busy, steer, queue,
abort replies, an unanswered server request, an unrequested exit). [Vendor tests](../../sea-trial/vendor/codex.vendor.test.ts)
use the real runtime with a scripted provider for tools, errors, instructions,
and usage shape. [CI](../../.github/workflows/ci.yml) configures three operating
systems with an unpinned CLI; configuration does not prove a release passed.

Priority gaps are multi-step/compaction context semantics, resumed reasoning
visibility, queue recovery, server-request handling (recorded, never
answered), and live child-thread delivery/identity.
Instruction tests explicitly defer compaction survival. Keep these gaps separate
from implemented methods and proposed v2 guarantees.

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
[oar-context]: ../../packages/oar/src/runtimes/codex/context-usage.ts
[oar-models]: ../../packages/oar/src/runtimes/codex/list-models.ts
