# Codex

Evidence baseline: native source pinned to [`4f39251a`][native-source]
(2026-08-22) unless a claim cites the newer upstream tree
[`2151d3a5`][upstream-tree] (2026-09-12); the [app-server guide][guide] is
rolling documentation. The OAR mapping was checked against source on
2026-10-05. Live observations come from **codex-cli 0.154.0**
(`gpt-5.3-codex-spark`, ChatGPT login, darwin) through
[`experiments/live-contract.ts codex`](../../experiments/live-contract.ts)
(13 scenarios, 2026-09-11), from
[`experiments/codex-child-threads.ts`](../../experiments/codex-child-threads.ts)
on **0.149.0**, and from the probes (handshake, steering/abort, model listing,
resume/model readback) in the [experiments index](../../experiments/README.md);
later observations name their own version. Versions are evidence baselines,
not a support range; a claim that holds only on a named binary is marked
[env]. See the [runtime index](README.md) for evidence and status conventions.

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

OAR starts one `codex app-server` process per Session, speaks app-server
protocol version 2 over stdio, and exposes it as the
[record stream](../spec/README.md): every notification is one Frame record
(params verbatim in `native`, OAR's reading in `events`), every control call is
a request record answered by the RPC reply, and codex's own `turn/completed`
ends the turn. The adapter declares `capabilities: { queue: { durable: true
}, attribution: "nested", images: true }`; the session has `steer` and no
`withdraw` ([queue](#prompt-steering-queueing-and-abort)).

| Native concept or boundary | Current OAR mapping |
|---|---|
| Thread identity | `Session.id` is the native thread id. The `thread/start` / `thread/resume` reply is the open Frame record (`type` = the method), carrying the `model` event (and `effort` when codex reports a level). Frames codex sends before that reply (notifications and server requests alike) are recorded ahead of it in wire order, and frames written after it (`thread/started`) follow it whatever the chunking. |
| Native turn | No OAR turn object. The turn starts at the `prompt` request record and ends at codex's `turn/completed` (`turn_ended`: `completed`; `interrupted` → aborted; any other status → failed, with the preceding `error` notification's detail appended). The native turn id rides every turn-scoped notification as `spanId` and is the precondition for steer and interrupt. |
| Items and notifications | One frame per notification, nothing dropped: `item/agentMessage/delta` → `text_delta` (`messageId` = `itemId`, the agentMessage item); `rawResponseItem/completed` reasoning → `reasoning`; `userMessage` items → `user_message`; `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` / `sleep` items → `tool_call_started` / `tool_call_ended` with the item type as `tool` and the item id as `callId` ([outcomes](#tool-call-outcome-reporting); a `sleep` is the model waiting, its input `{durationMs}` the wait it asked for, which a steer can end early, and `classifyTool` reads it as a `wait`; a `fileChange`'s input is its `changes` array, which `classifyTool` reads as one `edit_file` with every changed path as `paths`, see [file changes](#tools-permissions-and-client-callbacks)); `item/commandExecution/outputDelta` → `tool_call_progress` (`callId` = `itemId`, `output` = the delta) [env 0.154.0 schema]; `contextCompaction` items → `compaction_started` / `compaction_ended`; `item/completed` for `subAgentActivity` items → task events; `thread/tokenUsage/updated` → `usage`; `thread/settings/updated` → `model` / `effort` / `service_tier`; everything else is a frame with no events. No `retry` event: codex exposes no retry notification. |
| Control replies | The `turn/start`, `turn/steer`, `turn/interrupt` and `thread/queue/add` replies are the `accepted` / `rejected` responses to prompt / steer / abort / queue, with the reply as `native` (so the queue submission id is retained). Each response is recorded as the reply line is read, before notifications codex wrote after it. |
| Effective configuration | `model()`, `effort()` and `serviceTier()` fold the `model` / `effort` / `service_tier` events of the open reply and of `thread/settings/updated` ([models](#models-instructions-and-context)). Most native configuration has no public mutator. |
| Server requests | Recorded as `toApp` request records (method and params verbatim, the server's own id), never answered: `approvalPolicy: never` means none are expected, and one that arrives stays dangling. `events()` reads each as `app_request` with the method as `type`; no `app_answered` follows. `serverRequest/resolved {threadId, requestId}` (0.160.1 schema) reads as `app_request_cancelled`: OAR answered nothing, so codex cleared the request itself. Through OAR (`approvalPolicy: never`) neither question reaches the host: codex declines MCP elicitations itself and `request_user_input` is unavailable in Default mode. Driving 0.160.1 app-server directly, a `requestUserInput` (plan mode) and an MCP tool approval (`mcpServer/elicitation/request` under `on-request`) cut by `turn/interrupt` were each followed by `serverRequest/resolved` (numeric id 0, recorded as "0"), right after the interrupted `turn/completed`. codex also sends it after a client's answer, so once OAR answers codex requests this reading must tell the two apart. |
| Native children | Notifications of another thread are child-session records (`sessionId` = that thread id, a `graph()` node); a collaboration item naming `receiverThreadIds` / `agentThreadId` adds a `tool_call` edge from the sender thread; without such an item no edge is fabricated ([children](#observation-children-and-history)). |
| Process and observation lifetime | The Session owns its process; `dispose` is a request answered by the observed `exited` response (also recorded, pointing at no request, when the app-server dies on its own). The retained log backs the cursor for this process's lifetime; a resume starts a fresh stream at seq 0. |

Implementation: [session adapter][oar-session], [open request and
read-back][oar-open], [projection][oar-projection], [kernel][oar-kernel], and
[transport][oar-transport].

## Capability details

### Connection, session creation, and resume

OAR launches `codex app-server -c sandbox_mode="…" --listen stdio://` (see
[tools and permissions](#tools-permissions-and-client-callbacks)), sends
`initialize` (`clientInfo: { name: "oar" }`, `capabilities: { experimentalApi:
true }`), then the `initialized` notification; request ids correlate replies.
New sessions call `thread/start { cwd, model?, approvalPolicy: "never",
experimentalRawEvents: true, baseInstructions?, developerInstructions?,
config?: { model_reasoning_effort?, mcp_servers? } }`. OAR requires a thread id in the reply,
and a model and effort readback matching any explicit request, before
constructing its Session; otherwise it kills the process and throws (an RPC
failure reads `codex thread/start failed: <message>`).

The app-server talks before the thread exists ([env] 0.154.0):
`remoteControl/status/changed { status: "disabled", serverName,
installationId, environmentId: null }` follows the `initialize` reply in every
run and is seq 0, the open event is seq 1, and `thread/started` (root
`parentThreadId: null`) follows
([pre-open tests](../../tests/codex/codex-pre-open.test.ts)). An unknown model
slug opens and fails only at the first turn
([models](#models-instructions-and-context)).
[Adapter][oar-session], [transport][oar-transport],
[handshake probe](../../experiments/codex-handshake.ts).

**Resume.** The native call:

```text
thread/resume { threadId: savedThreadId, cwd, model? }
  → { thread: { id, turns, ... }, model, cwd, ...effectiveConfiguration }
```

It loads persisted conversation state or attaches to a thread already loaded
in that server; it does not submit a prompt (that is `turn/start`). The result
includes effective configuration and history, with native options to exclude
or page turns. Resume success is not turn completion, and returned history is
not replayed as live notifications. The pinned schema's experimental
history/path inputs are not exposed. [Resume schema][resume-schema].

**Mapped:** `codexRuntime.session(installation, { cwd, resume: savedSessionId,
model? })` sends `thread/resume { threadId, excludeTurns: true, cwd, model?,
approvalPolicy: "never", …instructions, config?: { mcp_servers } }`, requires a thread id, checks an
explicit `model` against the readback, and sets a differing effort afterwards
([effort](#models-instructions-and-context)). The token is a native thread id
resolved against the selected executable's runtime storage and configuration
(`CODEX_HOME`), not a portable transcript; a resume naming another `cwd` kept
the conversation and ran its shell there (0.160.0,
[resume in another directory](resume-cwd.md)). The resumed session keeps the
id and gets a fresh stream at seq 0: what the app-server said while loading
comes first ([env] 0.154.0: `remoteControl/status/changed`, `warning`, four
`mcpServer/startupStatus/updated`, `thread/status/changed idle`), then the
`thread/resume` reply as the open event at seq 7, and the model recalls the
earlier transcript (live-contract `resume`). With `excludeTurns` no history
is replayed into the stream; no cursor from the previous process is valid,
and nothing restores observer positions or a controller lease. Resume sends
no `experimentalRawEvents`, which would be inert there
([reasoning](#observation-children-and-history)).

**Token totals after a resume (mapped,
[#169](https://github.com/botiverse/oar/issues/169)).** codex's
`tokenUsage.total` spans the thread's life, across processes. Right after
the `thread/resume` reply codex re-reports it: one
`thread/tokenUsage/updated { threadId, turnId: <the previous turn's id>,
tokenUsage: { total, last, modelContextWindow } }`, then
`thread/goal/cleared` ([env] 0.154.0). It races the first prompt request
but comes ahead of that prompt's reply and of the turn's `turn/started`.
The adapter takes the first root report before the first root
`turn/started` of a resumed Session as its baseline and subtracts it from
every later root total, `cacheRead` and `cacheWrite` included, so `tokens`
and `usage()` count from when this Session opened
([spec](../spec/attribution.md#usage-one-constraint)). The re-report itself
reads `tokens` 0 and keeps its `context` reading, which is what the resumed
context holds. If the first root turn starts with no report yet, the
baseline is unknown: don't know, don't report, so the Session's root
`usage` events carry `context` only and `usage().total` stays null. On a
real 0.155.1 login (Ferry's recording, botiverse/ferry
`packages/core/test/fixtures/codex-resume.jsonl`) the first run ended at
18,185 in / 5 out; the resumed run re-reported 18,185 / 5, then
38,557 / 10, which the resumed Session reports as 20,372 / 5. Which codex
sends the re-report
([resume usage probe](../../experiments/codex-resume-usage.ts),
codex-aimock, Linux, one run per release, 2026-10-07):

| codex releases run | Re-report of the earlier total | Resumed Session's token totals |
|---|---|---|
| 0.151.0, 0.153.0, 0.154.0, 0.155.1, 0.160.1 | one frame before the first `turn/started`, under the previous turn's id | this Session's own: `usage()` counts from when it opened |
| 0.131.0 to 0.137.0, 0.141.0, 0.144.6, 0.149.0, 0.149.1, 0.150.0, 0.150.1 | none | none: no `tokens`, `usage().total` null |
| 0.118.0, 0.130.0 | inside the first turn, after its `userMessage` item and under that turn's own id | none: no `tokens`, `usage().total` null |

So from 0.151.0 a resumed Session reports this Session's numbers; earlier
releases, down to the [login](#login) floor 0.118.0 (the oldest codex OAR
names), report no token totals after a resume. A new (not resumed) Session
counts from zero on every release. Only the root thread is baselined:
whether codex re-reports a child thread's total when a child started before
the resume runs again is unobserved. [Baseline][oar-token-usage],
[tests](../../tests/codex/codex-token-usage.test.ts),
[recorded resume](../../tests/replay/codex-resume.test.ts).

A thread whose rollout was never written (no turn yet) cannot be resumed
([session identity](#matrix-columns), [floors](#resumability-floors)).
Missing or unloadable threads reject as `codex thread/resume failed:
<message>`; structured RPC error data is dropped. A `thread/resume` on a
connection already subscribed to the loaded thread drops the `model` override
and reports the old model, so the adapter refuses a readback mismatch
(killing the app-server it started) rather than run silently on another
model; the override applies on a cold load, the normal case since every
Session owns its process. OAR does not arbitrate independent controllers
resuming the same persisted identity.
[Resume/model probe](../../experiments/session-resume-model.ts),
[resume probe](../../experiments/session-resume.ts),
[resume tests](../../tests/codex/codex-session-resume-model.test.ts),
[error handling][oar-transport].

### Interrupted input

When a root `turn/completed` reports `interrupted`, OAR emits
`input_dropped {inputId, reason: "turn_interrupted"}` for each accepted
steer to that `expectedTurnId` without an `item/started` user-message echo.
The events precede `turn_ended` on that same native frame. Queue submissions,
already echoed steers, other turns and children are excluded; a completed
or failed turn does not establish discard.

This follows Codex's own restoration rule in
[`input_restore.rs` at ea27864](https://github.com/openai/codex/blob/ea27864f99f0b086cec2f9f0251b7190fb9844f1/codex-rs/tui/src/chatwidget/input_restore.rs#L340),
backed by `abort_all_tasks` removing the active turn and clearing pending
input in [`tasks/mod.rs`](https://github.com/openai/codex/blob/ea27864f99f0b086cec2f9f0251b7190fb9844f1/codex-rs/core/src/tasks/mod.rs#L549).
The [native 0.161.0 probe](../../experiments/input-interruption-2026-10-08.md)
confirmed acceptance without an echo, interrupted completion, and absence
from the next provider request. The
[vendor regression](../../sea-trial/vendor/input-dropped.vendor.test.ts)
runs that case with a local scripted provider.

### Prompt, steering, queueing, and abort

**Prompt (mapped):** native `turn/start { threadId, input }` returns
`{ turn: { id } }`; later notifications establish completion. `prompt(string)`
records a `prompt` request, sends the text input, and records the RPC reply
as the `accepted` response. It is `rejected` with the RPC error message, with
`codex turn/start returned no turn id` when the reply names none, or `busy`
while a root turn is active (a queued turn codex started on its own
included). Completion is codex's
`turn/completed`, exactly one `turn_ended` per prompt (live-contract
`multi-turn`). A basic one-word turn was 33 records with event kinds `model,
reasoning, text_delta, usage, turn_ended`, one `spanId`, dense seqs, every
frame carrying `native`, and `dispose` answered `exited { code: null }`
(live-contract `basic`). No skill input, structured-output schema, or per-turn
configuration is exposed. [Adapter][oar-session].

**Images (mapped):** `InputOptions.images` follow the text as `{ type:
"localImage", path }` items on `turn/start`, `turn/steer` and
`thread/queue/add`, the order codex's own composer sends; codex reads the file
and sends it upstream as an `input_image` data URL
([vendor test](../../sea-trial/vendor/images.vendor.test.ts); live with
codex-cli 0.155.1, 2026-09-29: a plain green PNG named `probe.png` was
answered `green`). OAR checks the file's type and readability first, so a bad
image refuses the input before any RPC.

With empty text and images, OAR sends only `localImage` items. Codex
0.161.0 wraps the provider's `input_image` in its own nonempty `input_text`
image delimiters. OAR neither adds a placeholder nor removes those native
labels. Verified with the [image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts), without a login.

**Input identity:** every prompt, steer and queue sends its `inputId` (a UUID,
assigned when the host gives none) as `clientUserMessageId`; codex echoes it as
the `userMessage` item's `clientId`, read on `item/started` as a
`user_message` event with that `inputId`. Acceptance and native observation
remain separate from model consumption. The
[conversation contract](../spec/conversation.md) specifies the echo mapping,
the steer → queue fallback, and the limits of acknowledgement evidence; the
[steer delivery probes](steer-delivery.md) hold the native observations.

**Steer (mapped, landing observed):** native `turn/steer { threadId,
expectedTurnId, input, clientUserMessageId }` binds input to the expected
active turn, so codex adjudicates the race; OAR supplies the native turn id
it retained from the `turn/start` reply or the latest root `turn/started`.
The `{ turnId }` reply is the `accepted` response (delivery ownership, not
model attention); every RPC error is `rejected runtime_refused` with a reason
prefixed `not_steerable:` (operational failures included), and with no
active turn the gate answers `no_active_turn` (`not_steerable: no active
turn`). A steer accepted while the turn's first tool ran appeared as a
`userMessage` item inside the same turn and shaped its final text (`ALPHA
BRAVO MANGO`), with one `turn_ended` (live-contract `steer`;
[adapter probe](../../experiments/codex-session-adapter.ts)).

**Instant interrupt (opt-in, observed on 0.159.0):** native `[features]
instant_interrupt = true` (off by default, under development upstream) makes
`turn/steer` preempt an unfinished model response or yield a running
code-mode cell early. OAR inherits the configuration and keeps its mapping
and default. The same native turn continues, the cell is not stopped, direct
tool calls still finish before new input is sampled, queue stays a next-turn
operation and abort still ends the turn. Partial deltas of the interrupted
assistant item can remain without an `item/completed`; Codex excludes them
from the replacement model context, and OAR keeps them as observations, not
committed transcript evidence
([seven-case probe, opt-in instructions and limits](../../experiments/codex-instant-interrupt.md)).

**Queue (mapped, `durable: true`):** native queue operations have submission
identities and inspection/editing methods. `queue()` calls `thread/queue/add
{ threadId, input, clientUserMessageId }` and keeps the reply
(`queuedSubmission { id, input, clientUserMessageId }`) as the accepted
response's `native`; inspection and editing are not exposed. Codex emits
`thread/queue/changed` at add and at drain, and the drained turn is
spontaneous: `turn/started` … `turn/completed` with no prompt request of its
own, its `userMessage` item carrying `clientId` = the submitted
`clientUserMessageId` (live-contract `queue`,
[queue probe](../../experiments/session-queue.ts)). The adapter adopts such a
turn as busy. A queued submission survived a SIGKILL of the whole process
tree and ran by itself as a new turn on resume, before any prompt (codex
0.158.0, one run, [crash and resume](crash-resume.md)), so a prompt sent
right after such a resume is rejected `busy` until that turn ends; a steer
accepted but not yet read when the process died was lost in the same run.
[Thread schema][thread-schema].

**Withdraw (not exposed):** the session has no `withdraw`. The queue is codex's
own, and its `thread/queue/delete` is experimental and not live-verified (its
`deleted: false` cannot tell "already dispatched" from "never there"), so OAR
does not claim it ([input cancellation](input-cancellation.md)).

**Abort (mapped):** native `turn/interrupt { threadId, turnId }` targets an
execution; `turn/completed` reports whether the interrupt won the race.
`abort()` records an `abort` request; the interrupt reply (`{}`) is its
`accepted` response, and an RPC error (the turn already finished) is a
`rejected` response with the runtime's message: a recorded race, not a
swallowed error. The outcome is `turn/completed`'s status, `interrupted` →
`aborted`. The reply is recorded after the frames codex wrote meanwhile (the
raw `function_call_output` `"Wall time: 2.2 seconds\naborted by user"`, a
usage update, rate limits), then `turn/completed { status: "interrupted",
items: [] }`; the interrupted `commandExecution` item gets no
`item/completed`, so its `tool_call_started` has no `tool_call_ended`
(live-contract `abort`). A second prompt during a turn is `rejected: busy`;
with nothing active, including after the turn, an abort is `rejected: no
active turn` and a steer `rejected: not_steerable: no active turn`
(live-contract `busy-and-late-control`;
[stream tests](../../tests/codex/codex-session-stream.test.ts)).

If the app-server exits before OAR's fallback with RPCs still pending, their
responses are `rejected: runtime_exited`, with the process diagnostics; a
native RPC refusal remains `runtime_refused`. If the interrupted turn has
not ended ten seconds after the first abort, OAR accepts its still-pending
abort requests before terminating the runtime using the cleanup below.
A late RPC reply remains a frame with its result or error payload, never a
second response. An acknowledgement alone does not clear the deadline;
`turn/completed` does. A native refusal cancels only that attempt.
The folds read exit after an accepted abort as `aborted`; an unrequested exit
remains `failed: runtime_exited`. A native turn end arriving first keeps its
outcome. The host must resume after forced termination to continue.
[Real-binary transport-fault test](../../sea-trial/vendor/abort-fallback.vendor.test.ts).

**Dispose and unreachable runtime:** `dispose()` records a `dispose` request,
kills the app-server and awaits its exit, recorded as the `exited` response
(signal death: `code: null`). OAR does not fabricate a native turn end: a dispose
mid-tool ends with `tool_call_started`, `dispose`, `exited { code: null }` and
no `turn_ended`, so the exit is the turn end for observers and `turnEndAfter`
reads `aborted` from the dispose request; the native exit code is unchanged
(live-contract `dispose-mid-turn`). Dispose
releases the process; it establishes no exclusive control over persisted
history. When the app-server dies on its own (SIGKILL mid-tool) the stream
gets `exited { code: null }` with `requestId: ""`; every later
prompt/steer/queue/abort is `rejected: runtime exited`, and a later
`dispose()` is answered `accepted`, nothing being left to release
(live-contract `kill-runtime`). Both reachability answers (`runtime exited`,
`session disposed`) are the shared kernel's, read off the stream before the
adapter's own gates; the adapter keeps no liveness flag. [Kernel][oar-kernel].

### Observation, children, and history

**Mapped:** native thread read/list/fork operations expose stored state, and
resume can return history; OAR exposes none of those and does not hydrate the
stream from the resume result. Every notification enters the stream verbatim
(`native` is the params object) with a session-local `seq`, ingress
`receivedAt`, and the native turn id as `spanId`; `rawEvents(observer,
{ sessionId, afterSeq })` replays the retained records of this process, then
continues live. A mid-turn subscribe's replay plus live delivery is contiguous
with the log, and a full replay equals `records()` (live-contract `cursor`).
There is no cross-process cursor, catch-up from codex's rollout, or
backpressure. The guide marks rollback deprecated; OAR does not expose it.

**Tool detail** (live-contract `tool-detail`): a `commandExecution` item
yields `tool_call_started` with the command as input (`/bin/zsh -lc 'echo …'`)
and `tool_call_ended` with the aggregated output and the item's `exitCode`,
same `callId` (the item id, `call_…`); the raw `function_call` names
`exec_command`; `item/commandExecution/outputDelta` frames carry the stdout,
read as `tool_call_progress`
([item-detail tests](../../tests/codex/codex-item-detail.test.ts)).

**Reasoning:** `thread/start` sends `experimentalRawEvents: true`, which adds
`rawResponseItem/completed` frames; `reasoning` events come only from those
(`item/started|completed` reasoning items carry no event). The generated
protocol schema (`codex app-server generate-json-schema`, [env] 0.154.0)
lists the flag on neither `ThreadStartParams` nor `ThreadResumeParams`, yet on
`thread/start` it yields raw frames: each turn opens with the raw `message`
items codex sent (developer skills/plugin instructions, the user prompt),
then reasoning, `function_call`, `function_call_output` and assistant message
items. On `thread/resume` the flag is inert, so a resumed stream has no
`reasoning` events (its reasoning items have empty summary and content). On
`gpt-5.3-codex-spark` every reasoning step is an `item/started` +
`item/completed { type: "reasoning", summary: [], content: [] }` pair plus
one raw reasoning item with empty `summary` and an `encrypted_content`, read
as `reasoning { kind: "redacted" }`; no plaintext reasoning appeared in any
live run (`reasoningEffort: "medium"`, `reasoningOutputTokens` > 0).
[Reasoning tests](../../tests/codex/codex-reasoning.test.ts),
[projection][oar-projection].

**Native children (nested):** the pinned `collabAgentToolCall` schema carries
`senderThreadId`, `receiverThreadIds`, and `agentsStates`; `subAgentActivity`
identifies a thread/path; the rolling guide documents `collabToolCall` with
different fields instead. Claude's `parent_tool_use_id` is not Codex's
linkage. OAR records notifications of other thread ids as child-session
records (`sessionId` is the child thread, a `graph()` node) and adds a
`tool_call` edge from the sender (`senderThreadId`, else the thread that
reported the item) to each `receiverThreadIds` / `agentThreadId` entry that
is not the sender. Lineage (an edge) stays distinct from observation (a
node), and no edge is fabricated. `agentPath` stays `[]` on every record:
attribution is `nested` (child session ids). Collaboration items carry no events,
except that `item/completed` for a `subAgentActivity` about the reporting
thread's own child is a task event with the child thread as task id (and as
`childSessionId` on `task_started`): `started` → `task_started` (the
`agentPath` as description), `interacted` → `task_updated` running,
`completed` → `task_ended` completed, `interrupted` → `task_ended` stopped
([env] 0.149.0 to 0.158.0, `completed` on 0.158.0; [tasks][oar-tasks],
[task views](../spec/subagents.md#tasks)). A subagent that messages a sibling
or the root reports `subAgentActivity` (`interacted`) on its own thread too
(0.158.0: alpha's `interacted /root/beta`, gamma's `interacted /root`); that
item stays on its frame and changes no task and no edge. Whether the item is
about the reporter's own child is decided by the recorded `started`, else by
the parent of its `agentPath`, else taken to be the reporter's
([#65](https://github.com/botiverse/oar/pull/65)).

On the wire, with `multi_agent` enabled ([env]; the item vocabulary differs
by build):

- Child notifications arrive on the parent's connection; the projection
  derives the child session and exactly one root → child edge (0.149.0: 3/3
  runs of `codex-child-threads.ts`; 0.154.0: live-contract `subagent`). No
  child `thread/started` is sent (the root's carries `parentThreadId: null`);
  the child first appears as `thread/status/changed` (idle → active → idle)
  with its own `threadId`, on 0.154.0 before the spawn item names it, so the
  graph node precedes the edge. The child then emits its own `warning`,
  `mcpServer/startupStatus/updated` ×4, `turn/started`, items,
  `rawResponseItem/completed` (raw events are on for the child),
  `thread/tokenUsage/updated` ×2, `turn/completed`.
- 0.149.0 emitted `subAgentActivity { kind: "started", agentThreadId:
  <child>, agentPath: "/root/<name>" }` (the edge source) plus
  `collabAgentToolCall { tool: "wait", status: "inProgress" → "completed",
  senderThreadId: <root>, receiverThreadIds: [] }`; the child emitted
  `subAgentActivity { kind: "interacted", agentThreadId: <root>, agentPath:
  "/root" }` once, which adds no edge and no task event because it names
  the parent.
- 0.154.0 (Spark, `multi_agent` stable/on, `multi_agent_v2` off) emitted only
  `collabAgentToolCall` (`tool: "spawnAgent"` and `"wait"`; no
  `subAgentActivity`, no `collabToolCall`) with `senderThreadId` (root),
  `receiverThreadIds` (`[]` on the spawn `item/started`, the child id on its
  `item/completed` and on both `wait` frames), `agentsStates` keyed by child
  id (`pendingInit` → `completed` with the child's final message), `prompt`,
  `model`, `reasoningEffort`. The edge derives from the spawn completion; the
  `wait` frames repeat it and `graph()` holds one edge. Spark discovers the
  collaboration tools through a `tool_search_call` (namespace
  `multi_agent_v1`) before the raw `spawn_agent` / `wait_agent`
  `function_call` items.
- `thread/tokenUsage/updated` arrives for both threads, each cumulative for
  its own thread; the child's stays in the child session's records, out of
  the root `usage()` (0.154.0: root 66290 in / 761 out after the turn, the
  child's cumulative 27317 kept apart).
- The child's `turn/completed` can precede the root's or never arrive; the
  root's own `turn/completed { status: "completed" }` came every time, its
  `wait` item completing on the child's message. `awaitTurnEnd` and the
  `model` / `usage` / `contextUsage` folds therefore scope to the root
  session ([fold tests](../../tests/observe-folds.test.ts)).
- No `toApp` request arrived during a sub-agent turn. Control of child
  threads is not exposed.

[Item schema][item-schema], [guide][guide],
[child-thread probe](../../experiments/codex-child-threads.ts),
[replay tests](../../tests/replay/codex-projection.test.ts).

### Service tiers

`SessionOptions.serviceTier` is sent on `thread/start` or `thread/resume`,
never `turn/start`. The open reply's `serviceTier` must match before OAR
returns a session. The native `fast` alias is **not** accepted as equivalent:
0.161.0 reports `priority`, so requesting `fast` fails with both names. Use
the model catalog's native ID. Unknown IDs that codex drops also fail the
readback. Provider-side restrictions can still fail a later turn.

The explicit opt-out `default` clears any special tier and is accepted even
though it is not a catalog entry. Native null is also a report of no tier,
projected as `default`; an absent field supplies no evidence. Open replies
and `thread/settings/updated` produce `service_tier` events for
`Session.serviceTier()` and `SessionView.serviceTier`.

On 0.161.0, **omitting the tier on resume reads the current configuration,
not the previous turn's tier**. With no `service_tier` in config, a priority
session resumes with null and sends no provider `service_tier`. With config
`service_tier = "priority"`, an omitted option resumes on priority. Passing
`default` overrides that config and removes the field from provider requests.
Priority and flex reach Responses requests as `service_tier: "priority"`
and `"flex"`. These cases use a real executable and scripted provider in
[service-tier.vendor.test.ts](../../sea-trial/vendor/service-tier.vendor.test.ts);
[dated evidence](../../experiments/service-tier-2026-10-08.md).

### Models, instructions, and context

**Model (mapped):** `model` on open selects the model for `thread/start` /
`thread/resume`; `model()` folds the open reply's `model` event (the runtime's
readback, available at open), and a readback differing from an explicit
request fails the open (`codex <method> kept model <readback> although
<requested> was requested`). An unknown model opens: `thread/start` reads the
slug back (`model: "oar-no-such-model-xyz"`) with a `warning` "Model metadata
… not found"; the first `turn/start` is accepted, then
`thread/status/changed { type: "systemError" }`, an `error` notification and
`turn/completed { status: "failed" }` give `turn_ended` failed with reason
`failed: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The
'oar-no-such-model-xyz' model is not supported when using Codex with a
ChatGPT account."}}`, class `invalid_request` (live-contract `bad-model`;
[readback probe](../../experiments/session-model-readback.ts)).

**Effort (mapped):** `SessionOptions.effort` governs every turn of the
thread, a turn codex starts from its own queue included ([env] 0.155.1). A
new thread takes it as the config override `config: {model_reasoning_effort}`
on `thread/start`; each Responses request then carries `reasoning: {effort}`,
and the reply's `reasoningEffort`, codex's word, is the open frame's `effort`
event. A resume takes no config override, because any `config` on
`thread/resume` rebuilds the thread's settings from `config.toml` and the
rebuild stays with the thread (live: a `gpt-6-luna` thread resumed without
`model` came back as `gpt-6-astra`, and a later plain resume with no turn
between still answered the config's model;
[experiment](../../experiments/effort-channels.ts); the
[vendor test](../../sea-trial/vendor/effort.vendor.test.ts) pins it with a
thread opened off the aimock default). A resume instead reads the level off
its reply and, when it is not the requested one, sends
`thread/settings/update {threadId, effort}` (experimental API, which OAR
enables); codex answers `{}` and pushes `thread/settings/updated
{threadSettings: {model, effort, ...}}`, read as `model` and `effort` events.
Live 2026-09-29: `thread/resume` reported `gpt-6-luna` / `low`, the pushed
settings `gpt-6-luna` / `medium`, and the rollout's `turn_context` recorded
`low`, then `medium`; on codex-aimock the wire read `low, low` over two turns
and `high` after a resume asking for it, on the thread's own model.

The open is refused when a start reply keeps another level (`codex
thread/start kept effort medium although effort low was requested`), or when
the resume update is refused, unconfirmed within 10 s, or pushes another
level. Without an effort, `thread/start` answers `reasoningEffort: null` (the
model default applies) and yields no `effort` event, and a resume runs and
reports the level and model the thread last ran with (live: `medium`,
although `config.toml` says `model_reasoning_effort = "low"`). codex validates
no level: it echoes an unknown one as `reasoningEffort` and forwards it, so
the open succeeds and the provider refuses the first turn (`turn_ended`
failed, `invalid_request`: "[ReasoningEffortParam] [reasoning.effort]
[invalid_enum_value] Invalid value: 'oar-no-such-effort'. Supported values
are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'."). The
per-turn `turn/start {effort}` ("for this turn and subsequent turns") is not
used: a submission codex drains from its queue starts a turn without one.
Live changes on a running thread are **not exposed**
([native surfaces](live-configure.md)). [Open request and
read-back][oar-open], [unit test](../../tests/codex/codex-session-effort.test.ts).

**Instructions:** `systemPrompt` maps to `baseInstructions` (replaces codex's
base prompt) and `appendSystemPrompt` to `developerInstructions` (appended as
a developer message); `instructions` / `userInstructions` are silently
ignored by `thread/start`. Cwd and the process environment overlay are
forwarded. Requested and effective configuration remain distinct.
[Vendor test](../../sea-trial/vendor/codex.vendor.test.ts).

**Model listing:** `listModels` opens a bounded app-server connection and
paginates `model/list`. `model` is the selectable identity, `displayName` is
presentation, hidden entries are omitted, and reasoning levels plus
`serviceTiers[].id` / `defaultServiceTier` come from that same native picker.
It does not read deprecated `additionalSpeedTiers`. No tier is invented for
`default`: that is the separate explicit opt-out. This path uses the same
home-initialization coordination as other app-server clients.
[Model listing][oar-models], [regressions](../../tests/codex/codex-service-tier.test.ts).

An empty `CODEX_HOME` without credentials still returns the built-in fallback
catalog: with Codex 0.161.0, `account/read` reported no account and OAR returned
`ok` with eight models. This lister does not return `unauthenticated`; listing
success is not evidence that the account can run those models. Startup, RPC,
malformed-response and timeout failures remain errors rather than empty lists.

The former `debug models` surface and the new picker returned the same seven
visible model IDs under the same existing login and provider configuration.
In the empty-home comparison, both returned the same eight IDs, with a different
order. This observation does not promise identical catalogs across future
versions or other providers. The native picker now also supplies service-tier
metadata. [Comparison and reproduction](../../experiments/service-tier-2026-10-08.md#model-catalog-comparison-2026-10-09).

**Context (mapped):** native usage separates `total`, `last`, and nullable
`modelContextWindow`. Each `thread/tokenUsage/updated` frame carries a
`usage` event: `context` = `last.totalTokens` (the last model call's input,
cached tokens included, plus its output: what the context holds once the
reply is in) against `modelContextWindow` with a rounded `percent`; `tokens`
= `total` input/output, with `total.cachedInputTokens` as `cacheRead` and
`total.cacheWriteInputTokens` as `cacheWrite`, less a resume's baseline so
they count from when this Session opened
([resume](#connection-session-creation-and-resume)). Both are already part of `inputTokens`: codex-api
`sse/responses.rs` at the pinned commit fills them from the Responses API's
`input_tokens_details.cached_tokens` / `cache_write_tokens` (its test: input
100 = read 40 + write 60). Live 0.154.0 read 32512 of 44166; codex-aimock on
0.160.0 reports both as 0, kept as 0. A codex without the write field
(before openai/codex#33454) yields `cacheRead` only
([spec](../spec/attribution.md#cache-reads-and-writes)). `last.totalTokens` is
codex's own occupancy reading (`TokenUsage::tokens_in_context_window` returns
`total_tokens`, and the TUI status card reads it off `last_token_usage`;
`protocol/src/protocol.rs` at [`4f39251a`][native-source]); codex's displayed
percent also subtracts a 12k `BASELINE_TOKENS`, which OAR does not. Without
`last` (older builds) occupancy is unknown: the cumulative input stands in as
`tokens` with window and percent null, so the cumulative total is never read
against the window; when only the window is absent, `tokens` is `last`'s and
window and percent are null. `contextUsage()` and `usage()` fold these
events, scoped to the root session.

The figures diverge live: over three one-word turns `total.inputTokens` grew
12661 → 28404 → 44166 while `last.totalTokens` stayed 12684 → 15749 → 15768
(`last.inputTokens` 12661 → 15743 → 15762) against a 121600 window;
`contextUsage()` reads about 11 % (13597 / 121600 after a basic turn) while
`usage()` climbs per turn (live-contract `multi-turn`, `basic`;
[replay test](../../tests/replay/codex-projection.test.ts)). One notification
arrives per model call, so a tool turn reports twice.
`account/rateLimits/updated` follows each model call and has no event ([env]
0.154.0: `limitId: "codex"`, `planType: "pro"`, primary 300-min and secondary
10080-min windows, reflecting the thread model's own windows: a Spark thread
reported 0-4 % / 0-2 % while the account's main Codex weekly window stood at
88 %). [Thread schema][thread-schema], [usage projection][oar-token-usage].

**Compaction:** a `contextCompaction` item yields `compaction_started` on
`item/started` and `compaction_ended` (completed, no trigger) on
`item/completed`; the deprecated `thread/compacted` notification (schema:
"Deprecated: Use ContextCompaction item type instead") ends an open compaction
only when the item did not already, which the projection's `compacting` flag
tracks [env 0.154.0 schema; not yet reached live]. Native manual compaction
(`thread/compact/start`, a client request) has no typed OAR operation; the
vendor instruction test defers compaction survival until it does.

### Tools, permissions, and client callbacks

App-server supports native policy plus server requests for command/file/permission
decisions, user input, MCP elicitation, and experimental dynamic tools. OAR
records each server request as a `toApp` request record and never answers it:
it sets `approvalPolicy: never` and launches with `-c
sandbox_mode="danger-full-access"`, the only seam that governs codex's exec
tool (`thread/start.sandboxMode` does not; pinned on a real login).
`OAR_CODEX_SANDBOX` pins a stricter mode, and `OAR_CODEX_SANDBOX=inherit`
skips the override so the user's own configuration wins. Configurations
requiring interactive settlement have no supported OAR interaction path: the
dangling request is the honest record
([stream tests](../../tests/codex/codex-session-stream.test.ts)); none arrived
in any live run.

A `fileChange` item carries `changes: [{path, kind, diff}]`, the same on
`item/started` and `item/completed`: `path` absolute, `kind` `{type: "add"}`,
`{type: "delete"}`, or `{type: "update", move_path}`, where `move_path`
(snake case) is `null` unless the update renames the file and then the
target's absolute path. The list came sorted by path, not in the patch's
order. The model's `apply_patch` sent through `exec_command` as a heredoc
arrives as this item, not as a `commandExecution` [env 0.160.1, scripted
provider: [recording](../../tests/replay/fixtures/codex-file-change.raw.jsonl)].
`tool_call_started.input` is the `changes` array as JSON. `classifyTool`
reads it as one `edit_file` whatever kinds the changes have; its `paths` are
each change's `path`, a rename's `move_path` right after its source, each
path once, and `detail` is the first of them
([test](../../tests/replay/tool-activity.test.ts)).

OAR projects command execution, file changes, MCP calls, web search and
sleeps ([outcomes](#tool-call-outcome-reporting)), but exposes no tool registration,
dynamic-tool execution callback, MCP management, or elicitation API.
Runtime-owned tools (MCP servers, skills, plugins) come from native
configuration, plus the session's own MCP servers
([below](#session-mcp-servers)). The inventories read them on their own app-server process:
`skills/list` and paginated `mcpServerStatus/list`, with tools explicitly
MCP-only (2026-09-16; [query contract](../spec/inventory.md),
[native probe evidence](inventory.md)). [Native interaction flows][approvals],
[transport][oar-transport], [projection][oar-projection].

### Session MCP servers

`SessionOptions.mcpServers` is the `config` override `mcp_servers` on both
`thread/start` and `thread/resume`, one table entry per server: stdio
`{command, args, env, enabled: true}`, http `{url, http_headers, enabled:
true}` ([open](../../packages/oar/src/runtimes/codex/open.ts)). Measured on
codex 0.160.1 against a scripted provider
([vendor test](../../sea-trial/vendor/mcp-servers.vendor.test.ts),
[recording](../../tests/replay/fixtures/codex-mcp-echo.raw.jsonl)):

- Both transports start (`mcpServer/startupStatus/updated` `starting`, then
  `ready`) and the model gets each server as one Responses `namespace` tool,
  `mcp__<name>`, its tools inside; a call must name that namespace beside
  the bare tool name (a flat `mcp__echo__echo` is answered "unsupported
  call: mcp__echo__echo"). aimock scripts only flat names, so the tests'
  provider proxy namespaces them (`namespaceMcpToolCalls` in
  [raw-capture](../../sea-trial/harness/raw-capture.ts)). The call is an
  `mcpToolCall` item whose result is the server's own text, so the server
  ran with the entry's `env` (stdio) or `http_headers` (http).
- A thread remembers none: resumed without the option, no server starts.
  Resumed with it, the servers start again and the thread kept its own
  model and effort (opened on `gpt-5.5` while config.toml says `gpt-5.1`;
  compare the live rebuild under an effort override in
  [models](#models-instructions-and-context), not re-checked on a login).
- codex merges config overrides into config.toml **field by field**, tables
  included, so the user's other servers stay and a server of the same name
  is merged into the user's entry: measured, a user `enabled = false`
  survived a session entry that did not set `enabled`, and a user `url`
  under a session `command` failed the open ("failed to load
  configuration: url is not supported for stdio"). OAR therefore always
  sets `args` (an array is replaced whole) and `enabled = true`: with the
  user's `echo` disabled and started with a bad flag, the session's `echo`
  started and was called, and the user's `userecho` was still offered. The
  user's other fields of that entry (more `env` keys, `env_vars`, `cwd`,
  timeouts, tool filters) still apply.
- The servers are nested under one `mcp_servers` key, not dotted
  `mcp_servers.<name>` keys, which a `.` in a name would split (`a.b`
  failed the open: "invalid transport"). A name outside codex's
  `^[a-zA-Z0-9_:@/.-]+$` opens the thread and then fails that server's
  startup ("Invalid MCP server name"), so OAR refuses it before starting
  codex.
- A stdio server gets codex's allowlisted environment (`HOME`, `PATH` and a
  few more; [subagents](../spec/subagents.md)) plus the entry's `env`, not
  `SessionOptions.env`.

The credentials reach codex only in the open request, which OAR does not
record; codex's frames name servers and their status, and a failing server's
`error` names no `env` or header value (0.160.1, a missing command and an
unreachable url). Every error the app-server client reports (codex's
message, the exit's stderr tail) passes a redactor that replaces each value
with `[redacted]` ([test](../../tests/codex/codex-session-mcp-servers.test.ts)).

### Process ownership, installation, and account usage

A synchronous host `exit` also kills OAR-owned process groups, including
live sessions and probes, and the descendants of each that left its group.
See [host lifetime and signal limits](../spec/record-stream.md#the-rules).

**Mapped:** OAR owns the spawned app-server; disposal kills it and waits for
the exit because the process may hold state (codex's sqlite runtime in
`CODEX_HOME`) that the next session needs released. On POSIX the app-server
leads its own process group, and the kill (SIGTERM to the group, then SIGKILL
after a grace period: 10 s, or `OAR_KILL_GRACE_MS`) settles disposal even
when it ignores SIGTERM ([test](../../tests/session-dispose.test.ts)). The
group does not hold every command: codex 0.160.1 runs an `exec_command` in a
session of its own (observed on Linux). So OAR also reads the app-server's
descendants from the process table when the kill begins and again just
before the SIGKILL, and SIGKILLs those still running, with their process
groups, at the SIGKILL or as soon as the app-server has exited; a pid is
signalled only while its start time matches. On Linux a stopped app-server's
command ended with it under the SIGKILL alone; the
[vendor test](../../sea-trial/vendor/stuck-runtime-tools.vendor.test.ts)
checks on the Linux and macOS runners that none outlives it. The limits are
[claude's](claude.md#process-ownership-environment-installation-and-account-usage):
a process that left the tree before the kill began is not reached. This
supplies resource release, not detached execution or a lease against other
controllers of the persisted thread. The environment overlay applies to the
child process; `null` removes an inherited variable
([environment contract](../spec/runtime-matrix.md#session-environment)).

On Windows, app-server disposal and the abort fallback force-terminate the
whole process tree with `taskkill /T /F`, including any launcher, with a
direct-child fallback if the tree walk fails. The host-exit hook runs this
synchronously; see the [lifetime limits](../spec/record-stream.md#the-rules).
The [dispose regression](../../tests/session-dispose.test.ts) checks both
the runtime behind a `.cmd` launcher and the tool it started are gone.

**First open per `CODEX_HOME` (coordinated):** native 0.160.0 can fail SQLite
initialization when several processes first open a fresh shared home: a direct
Linux probe failed 21/24 starts, while independent homes, a completed prior
initialization, and serial starts each initialized 24/24; this does not
establish the cause of similar Windows CI failures
([reproduction and limits](../../experiments/codex-concurrent-startup.md),
[upstream issue](https://github.com/openai/codex/issues/50290)). OAR
therefore coordinates the first app-server initialization of each home
within one loaded adapter module. Sessions, account usage and inventories
share this entry point: one process starts, and the others wait until its
`initialize` succeeds and `initialized` is sent; later starts on that home
can run concurrently. A failed initializer releases the next waiting client
after its exit, and its own caller still receives the original failure. Cancelling
a waiting client keeps its process from spawning, and query deadlines include
the wait. There is no added warmup process, delay or retry. The home is keyed
from the child's effective environment and working directory, with relative
paths and symlinks resolved and trailing separators ignored; readiness comes
from the observed handshake, not from a database file, and replacing the home
directory invalidates it. The coordination does not cover other host
processes, separately loaded copies of OAR, or external `codex debug models`
calls, and it is neither a native migration lock nor arbitration between controllers of
one thread
([implementation](../../packages/oar/src/runtimes/codex/home-initialization.ts),
[cancellation and concurrency tests](../../tests/codex/codex-home-initialization.test.ts)).

The older `codex debug models` probe stays outside because it did not
initialize the SQLite state database on 0.160.0/Linux (the probe's custom provider, no login): 24
standalone readers and 21 readers alongside three app-servers succeeded,
models-only homes held just their input config, and file-system tracing saw
no SQLite paths; the native implementation uses a separate model
catalog/cache. This is evidence for that version and environment, not a
guarantee
([models control and source](../../experiments/codex-concurrent-startup.md#model-listing-alongside-startup)).
A [vendor regression](../../sea-trial/vendor/codex.vendor.test.ts) bypasses
test-home warmup and opens eight real sessions concurrently in a fresh home:
all eight opened on 0.160.0/Linux (2026-10-02), and the test runs in the
cross-platform Codex CI jobs. It does not establish the root cause of the
earlier Windows failures.

**Exit diagnostics:** the process layer drains stderr continuously and keeps
its last 8 KiB. When the app-server exits, pending and later RPC calls fail
with its exit code, signal, any native spawn error and the stderr tail seen
by then, in the exception's message and cause; the `exited` record keeps its
shape. `OAR_CHILD_STDERR=inherit` also forwards stderr to the host's (never
for a [login](#login)'s app-server). A host
can tell a missing executable from a native crash; OAR makes no automatic
retry decision
([exit diagnostics tests](../../tests/codex/codex-exit-diagnostics.test.ts),
[spawn failure test](../../tests/codex/codex-startup-diagnostics.test.ts)).

Installation checks `OAR_CODEX_BIN`, then `codex` on PATH, then the macOS
desktop bundles (`ChatGPT.app` before the legacy `Codex.app`, system before
per-user installs), and requires `codex app-server --help` to succeed; a
codex without the app-server surface is unsupported. Account usage is a
separate reader on its own app-server process (`initialize`, `account/read`,
`account/rateLimits/read`, with `reauth_required` / `unsupported` outcomes and
rate-limit buckets merged as the codex TUI does); neither it nor installation
discovery is inferred from turn token totals. Update checks read the
`updates.status` row of `codex doctor --json`, and upgrades run `codex update`
with a version read-back ([runtime updaters](update.md)). Login is mapped
[below](#login). An installation probe that cannot run keeps its native error
code, signal, timeout, exit code and bounded stderr tail in the thrown error;
the probe deadline is unchanged, and an ordinary nonzero readiness exit still
classifies the installation as unsupported.
[Installation](../../packages/oar/src/runtimes/codex/installation.ts),
[account usage](../../packages/oar/src/runtimes/codex/account-usage.ts),
[update](../../packages/oar/src/runtimes/codex/update.ts).

### Login

**Mapped** ([runtime login](../spec/login.md)): `login` uses the app-server's
ChatGPT device code flow on its own app-server process: `initialize`, then
`account/login/start { type: "chatgptDeviceCode" }`, answered
`{ loginId, verificationUrl, userCode }` [schema 0.160.0], relayed as one
`device_code` event plus an `info` event on the account setting below. The
app-server polls by itself and ends with the `account/login/completed`
notification (`success`, `error`); a completion read before the start reply
waits for its login id. After a success OAR reads `account/read` for the
account (`email`, `planType`, `type`): no account is `failed` /
`not_logged_in`, and a read that fails, or a deadline or abort after the
success, is `logged_in` without an account, since codex has already stored
the login. The device code expires after 15 minutes; OAR's deadline is 16, so
codex reports the expiry itself. Cancelling or the deadline stops the
app-server with its process group on POSIX and its process tree on Windows
(an npm install runs it under a `cmd.exe` shim), which ends its polling. The
login's app-server never forwards its stderr, `OAR_CHILD_STDERR=inherit`
notwithstanding, and a failure `detail` is codex's one-line error or the exit
code, never the stderr tail. `chatgptDeviceCode` arrived in 0.118.0, so an
older codex is `unsupported` / `version_unsupported`.

The app-server writes the credential store only after the new tokens are
exchanged and the workspace check passes (`complete_device_code_login`, then
`persist_tokens_async`); a failure, a cancel or the expiry leaves the stored
login untouched. OAR never runs `codex login`: its browser and device code
flows call `clear_existing_auth_before_login`, which logs out and revokes
the current tokens before the new login completes, so a failed or abandoned
login would leave the user logged out [src `openai/codex` b741e480,
`app-server/src/request_processors/account_processor.rs`,
`login/src/device_code_auth.rs`, `cli/src/login.rs`]. Its browser flow also
listens on `127.0.0.1:1455`, which a phone cannot reach.

Device code sign-in must first be allowed in the ChatGPT account's security
settings, or by an admin for a workspace account, and is still in beta
[doc]; when it is not, codex's own error comes back as `failed` /
`rejected`. `authStatus` runs `codex login status`, which reads the local
credential store without a request: exit 0 logged in (`Logged in using
ChatGPT` or `... an API key`, read as the `method`; the masked key is never
read), exit 1 with `Not logged in` logged out, anything else (an unreadable
configuration) `unknown`. It names the method, not the account, so the status
(`oar login codex --status`: `logged in (chatgpt)`) has no email or plan;
only a login's own result carries the account, from `account/read`. OAR does
not parse codex's credential file to fill it in. Verified against a fake
app-server that answers with the 0.160.0 shapes
([tests](../../tests/login/codex-login.test.ts)), and on real logins: on
2026-10-05, on a fresh Linux test machine with claude 2.1.289 and codex
0.160.0, all five manual checklist steps of [#94](https://github.com/botiverse/oar/pull/94) (commit `f7e6428`) passed.
For codex: the status read, a login with the device code, and a cancel while
the code was shown (`login cancelled`, exit 130, no process left over, the
previous login unchanged).
[Login](../../packages/oar/src/runtimes/codex/login.ts).

### Logout

**Mapped** ([runtime logout](../spec/login.md#logout)): `logout` runs
`codex logout` over pipes with its stdin closed, and `codex login status`
decides. Native behavior [src `openai/codex` `rust-v0.160.1`:
`cli/src/login.rs` `run_logout`, `login/src/auth/manager.rs`
`logout_with_revoke`, `login/src/auth/revoke.rs`]: for a ChatGPT login codex
first revokes its refresh token (or, without one, its access token) at
`https://auth.openai.com/oauth/revoke` (10 s); a revoke that fails is only
logged and the local logout goes on. The revoke arrived in 0.122.0
([openai/codex#17825](https://github.com/openai/codex/pull/17825)); an older
codex only deletes. It then deletes the credential store,
`$CODEX_HOME/auth.json` and its keyring entry. An API key stored with
`codex login --with-api-key` is only deleted: it stays valid on the OpenAI
platform. codex prints `Successfully logged out` (exit 0), `Not logged in`
when nothing was stored (exit 0), or `Error logging out: <error>` (exit 1,
`rejected`). Observed in a temporary `CODEX_HOME` with no network [run
0.160.1]: an empty home answers `Not logged in` with exit 0 (`logged_out`); a
stored (fake) API key answers `Successfully logged out`, `auth.json` is gone,
and the status reads `Not logged in`. `OPENAI_API_KEY` and `CODEX_API_KEY`
are invisible to `codex login status` (it loads the store with the API-key
variable turned off), so a logout with either set is `logged_out` and leaves
the variable as it was, while codex goes on using it wherever it reads it
(`codex exec` reads `CODEX_API_KEY` [src `exec/src/lib.rs`]): a host must not
take `logged_out` to mean codex can no longer run. The deadline is 60 s. `codex logout` arrived in
0.15.0 ([openai/codex#1932](https://github.com/openai/codex/pull/1932)), so
an older codex is `unsupported` / `version_unsupported`. Verified against the
fake CLI ([tests](../../tests/login/codex-logout.test.ts)); the real-login
checklist of [#192](https://github.com/botiverse/oar/issues/192) is not run
yet. [Logout](../../packages/oar/src/runtimes/codex/logout.ts).

## Harness fact matrix

Answers to the harness investigation questions for the one interface OAR
calls: app-server protocol v2 over stdio, one process per Session. Evidence
labels: **source** is OAR code (the current mapping is in the sections
above); **source upstream** is the codex-rs tree at
[`2151d3a5`][upstream-tree]; **observed** is a recorded run on a named binary
(codex 0.154.0 live contract; 0.149.0 child thread probe); **observed by
@Faye** is her app-server probe of 2026-09-12, death boundary included
([investigation PR][faye-probe]), over the websocket transport against a local
Responses API mock with an isolated `CODEX_HOME`, so it speaks to server
behaviour, not to OAR's stdio path; **vendor** is native documentation no
observation here has confirmed.

**Resume** is the runtime rebuilding model context from its own persisted
material. **Replay** is OAR rebuilding an observer's event sequence from its
own appended stream, independent of runtime resume. The "runtime side resume
material" row describes the former only.

### Matrix columns

| Column | Codex on OAR's path | Evidence |
|---|---|---|
| Session identity | The native thread id ([mapping](#high-level-mapping-to-oar)). It survives the OAR process once codex has written the thread's rollout under `CODEX_HOME`. In the probe, a thread with no turn lived only in the server's in-memory loaded set: `thread/loaded/list` shows it, `thread/list` does not, the rollout `path` in the start reply does not exist on disk, and `thread/resume` fails `-32600 no rollout found` (observed by @Faye; matches the live contract observation on 0.154.0). | source [adapter][oar-session]; observed live contract resume 0.154.0; observed by @Faye; source upstream [rollout crate][upstream-rollout] |
| Connection identity | Implicit (of none, implicit, explicit id): the subscription relation is the identity. No frame carries a connection id, request ids are per client integers from 1, and over websocket neither the upgrade response nor the `initialize` reply carries one (observed by @Faye). The server keeps a `ConnectionId` per transport connection (`thread_state.rs`: `live_connections` and a per thread subscriber set that `thread/start` and `thread/resume` join and `thread/unsubscribe` leaves; a closed connection drops its pending request contexts) and a persistent `connection_id` column in `logs_2.sqlite` (0.153.4); neither reaches the wire. A client death leaves the subscriber set without any frame to the others. | source [transport][oar-transport]; source upstream [thread state][upstream-thread-state], [outgoing messages][upstream-outgoing]; observed by @Faye |
| Transport cursor | **Live stream cursor** (a position a reconnecting client hands back to get missed frames): none. No notification carries a sequence field, `turnId` is a span label and a `thread/items/list` filter, and `thread/resume` on a running thread delivers history plus a fresh full copy of every later frame, not a continuation (upstream comment "sends the thread's history to the client and atomically subscribes for new updates"; observed by @Faye: after B resumes, A and B receive frame for frame identical method sequences). **History pagination cursor:** `thread/resume` returns `itemsBackwardsCursor` and `turnsBackwardsCursor`, documented as opaque but observed as plaintext JSON `{ requestedThreadId, rolloutOrdinal, includeAnchor, scope }`; `rolloutOrdinal` is the `ordinal` every rollout line carries, monotonic from 0; a hand built cursor is accepted by `thread/items/list` and pages in both `sortDirection` values. It cannot reach a delta, because deltas are not persisted (question 2). OAR's process local `seq` is the only live cursor on this path. | source [kernel][oar-kernel]; source upstream [thread schema][upstream-thread-rs]; observed by @Faye |
| Event stream scope | One event record per notification on this stdio connection, child threads included, which arrive on the parent's connection (observed 0.149.0 and 0.154.0). As the sole subscriber OAR receives both [tiers](#broadcast-tier-and-subscription-tier) merged. | source [projection][oar-projection]; observed [child thread probe](../../experiments/codex-child-threads.ts); source upstream [outgoing messages][upstream-outgoing]; observed by @Faye |
| Runtime side resume material | `rollout-<timestamp>-<threadId>.jsonl` under `CODEX_HOME/sessions`, indexed by a sqlite state database in the same home: what `should_persist_response_item` and `should_persist_event_msg` admit (messages, reasoning, tool calls with outputs, compaction markers, turn started, completed, aborted, token counts), nothing OAR appended ([question 2](#six-questions)). `thread/resume` with `excludeTurns: true` feeds it to the model and replays nothing to OAR. Diagnostic reference only: OAR never replays observers from it. | source upstream [persistence policy][upstream-policy]; source adapter; observed [resume](#connection-session-creation-and-resume) |
| Vendor claim versus evidence | Observed on 0.154.0: resume continuity with `excludeTurns`, steer, queue, interrupt, dispose mid turn, child notifications on the parent connection, `exited` after kill; on 0.158.0, one run: a queued submission surviving process tree death. Probed outside OAR: websocket and unix socket transports. Vendor only: `codex app-server proxy`, the app-server daemon, Codex Cloud `history` resume, `ephemeral` threads, ingress overload error `-32001`. Unverified either way: arbitration between competing controllers, resumed reasoning content, compaction frames, what happens when a recorded server request is never answered. | this page, [open gaps](#verification-and-open-gaps), [crash and resume](crash-resume.md); vendor [app-server README][upstream-readme] |

### Eight dimensions

1. **Entry.** See [connection](#connection-session-creation-and-resume).
   Present upstream but not on OAR's path: `--listen ws://`,
   `--listen unix://`, `codex app-server daemon`, `codex app-server proxy`,
   `thread/fork`, `ephemeral`, `thread/resume { path }` and `{ history }`
   (vendor README).
2. **Session and state storage.** Thread identity, rollout, and the sqlite
   index are codex's, under `CODEX_HOME`. OAR owns no storage: its record
   stream is process memory behind `records()`, gone with the process
   ([kernel][oar-kernel]; source upstream rollout crate).
3. **Event model.** One record per JSON-RPC notification (`type` = method,
   `native` = params verbatim, the turn id as `spanId`); server requests (frames with
   both `id` and `method`) become `toApp` requests nobody answers; pre-open
   frames precede the open event; `turn/completed`'s `turn.status`
   (`completed`, `interrupted`, `failed`, `inProgress`) settles the outcome
   ([mapping](#high-level-mapping-to-oar);
   [stream tests](../../tests/codex/codex-session-stream.test.ts)).
4. **Ownership and identity.** The spawning OAR process owns the child;
   records carry `sessionId` and `agentPath`, and other threads become child
   records linked by collab `tool_call` edges. There is no lease: two OAR
   Sessions resuming one thread id are not arbitrated by codex (observed).
   The rollout's first line, `session_meta`, records an `originator` equal to
   the creating client's `clientInfo.name`, so a thread OAR created is marked
   `oar`; it is self reported and not verifiable (observed by @Faye).
5. **Capability honesty.** Declared as in the [mapping](#high-level-mapping-to-oar).
   Steer (`turn/steer { expectedTurnId }`) and queue (`thread/queue/add
   { clientUserMessageId }`) are held by codex, which is why queue is
   declared durable and the session has no `withdraw`; survival of process
   tree death was observed once ([queue](#prompt-steering-queueing-and-abort)).
6. **Deployment and lifecycle.** Local subprocess only. Process exit is an
   `exited` response answering `dispose`, or with `requestId ""` when codex
   died on its own (a live SIGKILL reads `code: null`; the fake-process test
   pins `137`). Pending requests are rejected `app-server exited`, later
   controls `runtime exited`, and `awaitTurnEnd` fails `runtime_exited`. No
   runtime frame announces death. Hosted forms upstream (daemon with
   `enable-remote-control`, unix socket control plane, proxy) are vendor only
   here ([pre-open tests](../../tests/codex/codex-pre-open.test.ts); vendor
   [daemon README][upstream-daemon]).
7. **Tools and permissions.** `approvalPolicy: "never"` and a full access
   sandbox, so no approval request is expected; one that arrives is recorded
   and left dangling ([tools](#tools-permissions-and-client-callbacks),
   [outcomes](#tool-call-outcome-reporting)).
8. **Extension points.** MCP servers, skills, apps, collab agents, and
   dynamic tools exist natively; OAR passes none of them. A Session's
   control calls are `turn/start`, `turn/steer`, `thread/queue/add` and
   `turn/interrupt`; inventories and account usage run their own app-server
   processes; model listing uses its own app-server `model/list` connection.

### Six questions

1. **Is the native session id stable across a host restart, and can it be
   reopened?** Yes ([resume](#connection-session-creation-and-resume)): a
   new process keeps the id and the model recalls earlier turns (observed,
   live contract; in another `cwd` too, 0.160.0), given the rollout under
   the active `CODEX_HOME`; a
   completed turn is not required once the rollout is written, but a newly
   allocated id without one is not enough ([floors](#resumability-floors)).
   An already subscribed connection silently drops the model override
   (observed). Upstream also accepts a rollout `path` and a Codex Cloud
   `history` (vendor).
2. **Does the runtime log keep every frame or only turn snapshots?**
   Neither: the rollout is a filtered item log. The persistence policy
   admits selected response items and core events, one line each with an
   explicit `ordinal`; app-server notifications as sent (`item/started`,
   deltas, `thread/tokenUsage/updated`), server requests, and OAR's own
   requests and rejections are absent by construction. A turn that emitted
   five `item/agentMessage/delta` frames left a 49 line rollout whose line
   types were only `session_meta`, `turn_context`, `world_state`,
   `response_item`, `event_msg` (`task_started`, `item_completed`,
   `token_count`, `task_complete`), and `token_usage_record` (observed by
   @Faye). Source upstream [policy][upstream-policy].
3. **Is a stream rebuilt from that log isomorphic to the original?** No.
   Absent: every OAR request and response record, `seq`, the pre-open
   frames, every delta, every server request. Recoverable: message content,
   tool calls with outputs and status, turn boundaries with status, token
   counts. A rebuild is a subset with a different envelope.
4. **Can a second observer attach to the same session?** On OAR's stream,
   any number: `rawEvents` with a cursor replays retained records after
   `afterSeq`, then continues live ([kernel][oar-kernel]); one stdio process
   has no second reader. On a shared server a connection that calls
   `thread/resume` gets its own full copy of every content frame from then
   on, and one that never subscribes gets only the broadcast tier (observed
   by @Faye). Neither receives earlier frames except through the history
   pages.
5. **Is there a recognizable last frame on process death, and what does the
   log say about an in flight tool call?** On OAR's path the process is the
   server: no runtime frame marks its death, the last record is OAR's
   `exited` response with `requestId ""`, a `tool_call_started` stays
   without `tool_call_ended`, and a child `turn/completed` may never arrive
   ([dispose](#prompt-steering-queueing-and-abort)); the rollout keeps the
   call without output, and after a resume the model is shown `aborted` for
   it, filled in when codex rebuilds the history and never written
   ([persistence surfaces](#four-persistence-surfaces-and-what-each-is-worth-at-death);
   0.158.0 in [crash and resume](crash-resume.md)). On a shared server a
   client death is not a thread event: a surviving subscriber receives every
   remaining frame through `turn/completed` with nothing marking the loss,
   and a turn whose only client was killed still runs to `completed`, with
   all items persisted, for a client that connects ten seconds later
   (observed by @Faye).
6. **Do hosted forms report environment lifecycle events?** Not on OAR's
   path. Upstream, a daemon or unix socket server outlives any one client
   and unloads idle unsubscribed threads; `thread/status/changed` is
   broadcast, so thread activity is visible to observers, but a peer
   connection closing produces no frame (observed by @Faye). Whether a
   client is told about an unload is unverified; the daemon and proxy paths
   are open.

### Tool call outcome reporting

Codex reports status on tool items (source upstream [item schema][upstream-item]):
`commandExecution` carries `status` (`completed`, `failed`, `declined`,
`inProgress`) and `exitCode`; `fileChange` carries `status` (same set);
`mcpToolCall`, `dynamicToolCall`, and `collabAgentToolCall` carry `status`
(`completed`, `failed`, `inProgress`), and `mcpToolCall` adds `error
{ message }`; `webSearch` and `sleep` have no status. OAR maps explicit
`completed` to `tool_call_ended.result: "ok"` and explicit `failed` to
`"failed"`; any other status, `declined` included, or none leaves `result`
absent, the native status remaining on the frame (a `sleep` ends with neither
`result` nor `content`,
[item-detail tests](../../tests/codex/codex-item-detail.test.ts)). OAR does
not infer a result from an exit code or output. A `commandExecution` item's `exitCode` is carried as
`tool_call_ended.exitCode` (`null` when codex reports a signal exit, absent
when the item has none), and its `aggregatedOutput` is the event's text
`content` as-is (the status when the output is empty), the exit status not
folded in. An `mcpToolCall`'s MCP blocks are its ordered parts (an image is an
image part); other items' `content` comes from [`item-detail.ts`][oar-item-detail].

## Native storage and listing, probed live

Evidence baseline for this section: **codex-cli 0.153.4**, Linux x86_64,
probed 2026-09-12 through the app-server control socket (a WebSocket over
AF_UNIX) against an isolated `CODEX_HOME`, so the shared `~/.codex` socket was
never created or touched. Statements are observations unless labelled a vendor
declaration or an inference; [env] marks a claim that holds only on this
binary. Nothing here is OAR behaviour: it is what the runtime does underneath
the adapter, including two capability-honesty failures a client cannot detect
from the response it gets.

### `thread/list` can return a well-formed empty page over a populated database

With 8 `threads` rows and 7 rollout files whose threads resume and load,
`thread/list` returned `{"data": [], "nextCursor": null, "backwardsCursor":
null}` on every call. When the client omits `modelProviders`, the server adds
a `threads.model_provider IN (...)` clause that no row can satisfy. Varying only
that parameter, database and daemon untouched:

| `modelProviders` sent | Rows returned |
|---|---|
| omitted | 0 |
| `null` | 0 |
| `[]` | 7, every row with `preview <> ''` |
| `["mockr"]` | 4 |
| all four providers | 7 |

`Some(vec![])` omits the clause and `None` adds it, so **the absent parameter
is strictly more restrictive than the explicit empty one**: a client that
means "do not filter" has to send `[]`. [env] The default query evaluates four
columns only (all 38 swept): `archived`, `preview`, `source` and
`model_provider`; rows pass `source`, so it is not the excluder. What the
`None` branch binds is **not established**. The best reading is SQL `NULL`
(`x IN (NULL)` is NULL for every row, so not empty, never satisfied, never
an error, matching all three observations), but **that is an inference, not
an observation**, and value probing cannot settle it: inside a pure
conjunction NULL and false are observationally identical. Excluded by probing: 13
non-`threads` tables renamed one at a time (only `thread_sections` fired, a
different join) and 66 candidate values spanning all five SQLite storage
classes.

### Empty pages have at least four causes

Rows with an empty `preview` are invisible by design: `threads` carries three
partial indexes, `idx_threads_visible_created_at_ms`, `_updated_at_ms` and
`_recency_at_ms`, all `WHERE preview <> ''` ("visible" is the runtime's own
word). Such a row never appears even with `modelProviders: []`, yet it
resumes: listability and resumability are independent. The list path also
swallows database errors: with the whole `threads` table renamed away, the
wire still carries a well-formed `{"data": [], "nextCursor": null}`, and the
only trace is one daemon log line, `WARN codex_rollout::state_db: state db
list_threads failed: ...` (the list path is `codex_rollout::state_db`;
`codex_state` has zero hits in trace-level logs). **On the wire, "the
database is broken" and "there are no threads" are indistinguishable.** The
causes must not be collapsed into one:

| Real cause of an empty page | Character |
|---|---|
| the database genuinely holds no thread | normal |
| rows exist but `preview` is empty, so they are filtered by design | legitimate, listability is its own state face |
| `modelProviders` omitted, injecting an unsatisfiable condition | defect |
| a database error was swallowed | defect |

### Probe method and its limits

The method works against any closed-source SQLite reader. sqlx statements
never reach the daemon log, even at trace level (`sqlx`, `codex_state` and
`threads.rs` have zero hits while `tokio_tungstenite`, `mio::poll` and
`notify::inotify` appear: the EnvFilter is global, and sqlx either logs
through `log` without a `tracing-log` bridge or has statement logging off at
`ConnectOptions`, neither reachable from outside the process). So the probe
breaks the schema and lets the failure name the identifier: `ALTER TABLE
threads RENAME TO threads_real`, then a same-named view of all 38 columns
with exactly one replaced by an expression that fails at runtime. SQLite evaluates it only
for rows that reach it, so a WARN proves the column was evaluated. Working
poisons: `abs(-9223372036854775808)` (integer overflow),
`zeroblob(2000000000)` and `randomblob(2000000000)` (string or blob too big),
`load_extension('nope')`; `9223372036854775807+1` returns a real and does not
error. `CASE id WHEN '<id1>' THEN <cand1> ... END AS model_provider` tests N
candidates in one query, the returned id naming the match, and renaming each
table in turn shows which tables a closed query touches. Limits:

1. **A poison firing and a row count cannot be read from the same run:** a
   firing poison forces the count to 0 (one combined run read the
   self-contradictory `passWHERE=YES n=4`).
2. **An empty literal `IN ()` does not evaluate its left-hand side; an empty
   subquery `IN (SELECT 1 WHERE 0)` does.** A firing poison proves the clause
   exists, **not** that the bound list is non-empty.
3. **An absent syscall does not prove a path was not taken.** `thread/list`
   reads the state database (0 `pread64` in the control run, 6 in the
   treatment run), yet SQLite's in-process page cache served a small, fully
   cached database with no syscall at all.

### Four persistence surfaces, and what each is worth at death

Log completeness can only be answered per surface.

| Surface | Behaviour at death | Usable as truth |
|---|---|---|
| rollout JSONL | no completed append was lost in the observed SIGKILL runs; power-loss durability was not tested | yes, the sole truth |
| `thread_history_1.sqlite` projection | keeps pace even under SIGKILL, rebuilt incrementally from a byte offset plus `next_rollout_ordinal` | yes, but it is a projection |
| `logs_2.sqlite` | a buffered, periodically flushed sink that does not flush at death; a short-lived process can lose all of it | no |
| `session_index.jsonl` | appends thread name changes only, 3 rows locally, all for zero-turn threads | no, it is not a session table |

- **A tool-call result may be `unknown` or `in-flight` and must not be coerced
  to `failed`.** A SIGKILL leaves a `function_call` with neither an output nor
  a failure; writing it down as failed manufactures a fact. A graceful drain
  is the opposite case: the rollout already holds `failed` and `-1` while the
  wire has carried nothing.
- **Append-before-deliver needs ordering and granularity together.** Appending
  before delivering makes replay-from-log a superset of what any connection
  received, so a reconnect only fetches the difference (delivering first loses
  "delivered but not persisted" at the death point, and no contract can repair
  that), and **the append granularity must not be coarser than the delivery
  granularity**. Codex satisfies both at event granularity and fails the
  second at delta granularity: deltas are delivered and never persisted.

The ordinal has three spellings that should not be mixed: the rollout JSONL
line key `ordinal`, the wire cursor payload field `rolloutOrdinal`, and the
SQLite projection column `next_rollout_ordinal`.

### Resumability floors

An id is minted, persisted, and becomes resumable at three different moments;
a caller needs the floor.

- Thread floor: the rollout's first append, ordinal 0 `session_meta`. A thread
  interrupted by SIGKILL still resumes.
- Item floor, strictly higher: `item_completed` reaching disk. A thread killed
  mid-item resumes reporting `itemsBackwardsCursor.rolloutOrdinal` 7 where a
  cleanly ended twin reports 17.
- Resume returns a cursor, not content: `initialTurnsPage` is `null`.
- An empty `thread/list` page is not evidence that nothing is resumable
  (the `modelProviders` defect, independent listability). Turn-less threads
  do not enter `thread/list` at all.

### Broadcast tier and subscription tier

Notifications split into two tiers, identically over stdio and over the
WebSocket on AF_UNIX (the `proxy --sock` path is a byte relay and does not
itself upgrade), matching the upstream `Broadcast` versus `ToConnection`
envelopes ([outgoing messages][upstream-outgoing]) and @Faye's websocket probe.

- Broadcast tier, reaching every initialized connection, including one that
  never named the thread: `thread/started`, `thread/name/updated`,
  `thread/status/changed`.
- Subscription tier, reaching only connections subscribed through
  `thread/start` or `thread/resume`, each with a full copy: `turn/*`,
  `item/*`, the deltas, and `thread/tokenUsage/updated`.

`thread/unsubscribe` closes the subscription tier only, so an observer
connection sees whether a thread is busy but not what it is doing; the server
unloads a thread that is idle with no subscribers. With implicit connection
identity and no live-stream cursor ([matrix](#matrix-columns)), the exact live
notification sequence, deltas especially, cannot be recovered from the
runtime; persisted items remain available through history APIs.

### Acknowledgement, persisted preference, and runtime state can disagree

Each capability has to be asked which face carries its real state; the three
faces routinely answer differently. Enabling remote control, the CLI reports
`enabled`, nothing is persisted (`persistence_preference: None`), and the
runtime reports `Connecting -> Errored`: one log line carries
`desired_state=Enabled { persistence_preference: None }` immediately followed
by `Connecting -> Errored`, all three faces at the same instant, disagreeing.
**Reading only the CLI's `enabled` yields an entirely wrong conclusion.**

## Verification and open gaps

[`experiments/live-contract.ts codex`](../../experiments/live-contract.ts)
covers every promise above on a real login, one voyage log per scenario:
basic, multi-turn, tool-detail, busy-and-late-control, steer, queue, abort,
dispose-mid-turn, cursor, resume, subagent, kill-runtime, bad-model. The
[experiments index](../../experiments/README.md) lists the further probes
(handshake; adapter steer/abort/busy; resume; resume with a model switch;
queue; model listing; model readback; child threads). Unit and replay tests
pin: the notification → record projection, child-thread attribution, collab
edges, the error-detail fold, the context/usage split and compaction
([replay](../../tests/replay/codex-projection.test.ts)); that a child
session's turn end and usage never satisfy the root folds
([folds](../../tests/observe-folds.test.ts)); resume parameters and model
mismatch ([resume](../../tests/codex/codex-session-resume-model.test.ts));
the stream shape: request/response ordering, busy, steer, queue and abort
replies, a refused interrupt, an unanswered server request, an unrequested
exit ([stream](../../tests/codex/codex-session-stream.test.ts)); pre-open
ordering, the open event ahead of a same-chunk `thread/started`, and control
after an unrequested death ([pre-open](../../tests/codex/codex-pre-open.test.ts));
item detail (the `sleep` item included), a recorded `fileChange`'s paths
([activity](../../tests/replay/tool-activity.test.ts)), reasoning classification, the
effort read-back, first-open coordination per home and exit diagnostics
([codex tests](../../tests/codex/)); the resume token baseline, from a
recorded codex-aimock resume, Ferry's real-login numbers and a resumed
Session's `usage()` ([replay](../../tests/replay/codex-resume.test.ts),
[usage](../../tests/codex/codex-token-usage.test.ts),
[resume](../../tests/codex/codex-session-resume-model.test.ts)). [Vendor
tests](../../sea-trial/vendor/codex.vendor.test.ts) use the real app-server
with a scripted provider for tools, errors, instructions, usage shape, a
resumed Session's `usage()` and verbatim stream order. [CI](../../.github/workflows/ci.yml) runs that backend
on three operating systems with an unpinned CLI; configuration does not prove
a release passed.

Open gaps:

- Compaction: the per-call context reading is verified; compaction frames,
  context after native compaction, and instruction survival through it are
  not, and `thread/compact/start` is unreachable through the Session API.
- Resumed reasoning: raw events cannot be enabled on `thread/resume`, so a
  resumed session has no `reasoning` events.
- Resumed token totals: before 0.151.0 codex sends no re-report ahead of the
  first turn, so a resumed Session reports no token totals there; child
  threads are never baselined
  ([resume](#connection-session-creation-and-resume)).
- Queue durability across process death: one whole-tree SIGKILL run on
  0.158.0 ([crash and resume](crash-resume.md)), not repeated.
- Server requests are recorded, never answered; no configuration requiring
  approval, user input or elicitation has been exercised.
- Child threads: delivery and identity are [env] on 0.149.0 / 0.154.0 with
  differing item vocabularies; control of child threads is not exposed; a
  child `turn/completed` that never arrives is observed but unexplained.
- Missing/unloadable thread ids on resume are pinned only by the fake-process
  path; concurrent controllers of one thread are not arbitrated.
- Session MCP servers are verified against a scripted provider only: on a
  real login, whether a `thread/resume` carrying `mcp_servers` keeps the
  thread's model (it did on 0.160.1 with aimock), and an MCP call the model
  itself namespaces.
- Storage (0.153.4): the `modelProviders` `None` branch's bound value is an
  inference (SQL `NULL`) that probing from outside cannot settle; why
  `thread_sections` joins the default `thread/list` query is unexplained;
  `thread/environment/connected` and `thread/environment/disconnected` exist
  in the protocol but were not observed live (vendor declaration only);
  `threads.sandbox_policy` reads `{"type":"disabled"}` while the same
  thread's `turn_context.sandbox_policy` reads
  `{"type":"danger-full-access"}`, recorded, not reconciled.
- Not probed on 0.153.4: `ephemeral: true` on `thread/start`, whether
  unloading a thread notifies clients, `thread/fork`,
  `serverRequest/resolved`, `thread/closed`, `thread/timeline/list`,
  `thread/read`, the write path for `thread_artifacts` /
  `thread_spawn_edges` / `thread_goals`, `codex agents`,
  `codex remote-control pair`, and `write_stdin` against a live unified-exec
  session id.

[native-source]: https://github.com/openai/codex/tree/4f39251a010a8bd7d692d25fb33832ff06f1635a
[thread-schema]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
[item-schema]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/app-server-protocol/src/protocol/v2/item.rs
[resume-schema]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L332-L438
[ts-sdk]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/sdk/typescript/README.md
[python-sdk]: https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/sdk/python/README.md
[guide]: https://learn.chatgpt.com/docs/app-server
[approvals]: https://learn.chatgpt.com/docs/app-server#approvals
[oar-session]: ../../packages/oar/src/runtimes/codex/session.ts
[oar-open]: ../../packages/oar/src/runtimes/codex/open.ts
[oar-projection]: ../../packages/oar/src/runtimes/codex/projection.ts
[oar-token-usage]: ../../packages/oar/src/runtimes/codex/token-usage.ts
[oar-tasks]: ../../packages/oar/src/runtimes/codex/tasks.ts
[oar-item-detail]: ../../packages/oar/src/runtimes/codex/item-detail.ts
[oar-kernel]: ../../packages/oar/src/shared/session-kernel.ts
[oar-transport]: ../../packages/oar/src/runtimes/codex/app-server-client.ts
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
[faye-probe]: https://github.com/botiverse/oar/pull/17

## Disallowed tools

`SessionOptions.disallowedTools` supports MCP names in the qualified form
`mcp__server__tool`. Built-ins (for example `exec_command`) and unqualified
names are refused with `UnsupportedOptionError` before app-server starts.

For a non-empty MCP list, OAR reads effective native config with
`config/read {cwd, includeLayers:false}` before opening the thread. It
resolves each unmodified server namespace against configured and session
MCP servers, unions the requested names with that server's existing
`disabled_tools`, and sends only those filters in the session's
`config.mcp_servers` override on `thread/start` / `thread/resume`. Other
server fields, native allowlists and existing denies stay in place. No
configuration file is edited and no credential from `config/read` is
copied into the override or record stream. Unknown, ambiguous or normalized
server namespaces are refused before the thread opens, naming the entries.
Supply the list again on resume; an empty list adds no override.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go after `app-server` and OAR's own `-c` overrides, before `--listen stdio://`; codex reads `-c key=value` there, for example `-c service_tier="fast"`. codex applies `-c` overrides in command-line order (`codex-rs/utils/cli/src/config_override.rs`), so a host `-c` for a key OAR also sets (`sandbox_mode`) is the one that applies. OAR passes them unchecked and never records them; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).
