# One stream, three record kinds

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 5-8](../design/hard-problems.md#the-session-and-event-model),
> [foundations](../design/foundations.md).

Control (prompt / steer / queue / abort / dispose and their replies) and
facts (what the runtime actually said) are records on one stream, and
control never decides whether a fact exists. A model that pushes both
through control objects lets the control plane trim, synthesize, and
constrain facts, so whether a fact exists depends on whether an object is
still alive. Attribution, the session graph, and the cursor cannot be built
on a stream that loses facts.

## Evidence A: five ways a control-shaped event model loses facts

- **Synthesized turn boundaries**: if `begin()` / `settle()` fan out
  `turn_started` / `turn_ended` themselves, the skeleton of the stream comes
  from "our API was called", not from the runtime.
- **A closed control plane swallows facts**: an `if (!isSettled) fanOut(...)`
  gate silently drops runtime events arriving after settlement.
- **A mandatory `turnId` loses facts without a turn**: pi's session-level
  events (compaction, queue, retry) belong to no turn and would have
  nowhere to go.
- **One answer split across two paths**: a turn outcome half in a promise
  and half in an event, or a steer half in a return value and half in the
  stream, forces every consumer to join the two.
- **Query masquerade**: a `contextUsage()` that caches the latest usage seen
  carries no seq, so it can neither be aligned with other records nor
  replayed.

## Evidence B: why the fix is *not* "split into two channels"

Every shipped runtime does this in a single channel:

- kimi-cli's message algebra is one union whose discriminator is "does it
  expect a reply": `type WireMessage = Event | Request`, the `Request`
  docstring verbatim "a message that expects a response". On the wire only
  the shape differs (a request has an id); one `_write_queue` and one
  `wire.jsonl` hold everything.
  [src: kimi-cli@cbc15c0 wire/types.py; wire/jsonrpc.py:49-56,174-204;
  wire/server.py; wire/file.py]
  KLIP-12 lists "no new transport channel" as a non-goal.
  [doc: klip-12, Implemented]
- codex: `OutgoingMessage` carries notification / request / response on
  one connection. [src: codex-rs/app-server/src/outgoing_message.rs:1-80]
- kimi-cli routes sub-agent records **by obligation** (request-class records
  passed through verbatim, the rest wrapped as `SubagentEvent`) on the same
  channel and send: the split is by obligation, not by channel.
  [src: subagents/runner.py:393-428]

Total order is what channel-splitting cannot buy back: two paths share no
seq, so "did the abort land before or after that tool_result" becomes
permanently unanswerable.

## The rules

**frame**: the runtime's own words. Expects no reply; append-only;
monotonic seq. oar never synthesizes a frame. The turn's start *is* the
prompt request itself, and its end is the runtime's own completion event
(claude's `result`, codex's `turn/completed`); if a runtime doesn't report
one, it is honestly absent. No oar-made facts exist in the stream, so there
is no origin self-disclosure label.

**request**: an action record that expects an outcome; bidirectional.
app→runtime: prompt / steer / queue / abort / dispose. runtime→app:
approvals, questions, external tools. toApp request bodies are runtime
verbatim with an open vocabulary, so `direction` is the only way a server
can decide "does the app need to answer this" without understanding the
body.

**response**: must point at a request (`requestId`); the reverse is not
guaranteed. A response exists *only* when oar observed an outcome the
runtime will not say itself (e.g. the process exit code after a dispose).
Outcomes the runtime does say (a prompt completing) are answered by its own
frames, and oar adds no echoing response (it would be a synthesized
`turn_ended` under a new name). A request without a response is an honest
record: the action was initiated and the outcome was not observed (crash,
oar itself killed). Backfilling a guessed response is forbidden.

Further rules:

- **Control never prunes facts.** There is no settled-gate anywhere:
  whatever the runtime said must enter the stream, even if it lands after a
  span has ended.
- **Reachability is read off the stream.** Once the stream holds an
  `exited` response (the runtime is gone) or a `dispose` request (the
  session is being released), every later prompt / steer / queue / abort
  request is rejected (`runtime_exited` / `disposed`) by the shared kernel
  before any adapter code runs: no adapter keeps a private "is it alive"
  flag. `dispose` is the one control that still goes through after an
  observed exit: it is recorded and answered `accepted` at once (nothing is
  left to release), so a session whose runtime died on its own still ends
  with an answered dispose rather than a dangling one.
- **Control responses answer only "accepted or not".** Final states and
  landing points are always events. A rejection carries one typed `code`
  (`busy`, `no_active_turn`, `unsupported`, `runtime_exited`, `disposed`,
  `runtime_refused`, `error`) next to the prose `reason`, so an application
  branches on a word, not on vendor text. Counterexample: kimi-cli leaks the
  turn outcome into `_handle_prompt`'s return value, while the `TurnEnd`
  docstring admits it "may be omitted" when interrupted.
  [src: wire/server.py:644-755; wire/types.py]
- **A turn is a span on the stream, not a control object.** The envelope's
  optional `spanId` holds only runtime-native ids (red line in
  [runtime-matrix.md](runtime-matrix.md)); records without a native turn
  id, such as pi's session-scoped frames, have none.
- **Query is a projection over the stream.** `model()`, `effort()`,
  `usage()`, `contextUsage()` and `status()` are folds over the retained
  records and return `{ value, seq }`; `seq` is the last record consumed,
  or `-1` before any record. `status()` is the one the control decisions
  must agree with: a prompt recorded while it says `running` is rejected
  `busy`, and one recorded while it says `idle` never is.
- **Folds scope to the root session.** A derived child session's records
  (own `sessionId`, a node in `graph()`) never satisfy the folds or
  `awaitTurnEnd`. On codex the child's `turn/completed` was observed
  arriving before the root's ([env] 0.149.0), and the child's cumulative
  usage would otherwise overwrite the root's under `agentPath []`. Scope a
  fold to a child by passing its `sessionId` (`usageOf(records, sessionId)`).
- **Tool outcomes are the runtime's.** `tool_call_ended.result` (`"ok"` |
  `"failed"`) is present only when the runtime explicitly reports the
  outcome; oar never infers it from output, exit codes, or timing.
  `exitCode` follows the same rule for the process status of a command the
  runtime ran: present only when the runtime reported one (codex, grok,
  cursor), `null` when it reported a signal exit, absent otherwise (claude
  and pi report none).
- **A tool result is its parts.** `tool_call_ended.content` is the result
  as the runtime reported it, in its order: `{type: "text", text}`,
  `{type: "image", mediaType, data}` (base64, normalized from Anthropic
  `source` blocks and MCP / pi / ACP `{data, mimeType}` blocks alike), and
  `{type: "other", value}` for a block or a result OAR does not recognize,
  kept whole. A plain string result is one text part; `content` is absent
  when the runtime reported no result. The frame's `native` keeps the
  original. `toolResultText(content)` (`@botiverse/oar/observe`) joins the
  text parts for a host that shows only text. Streamed output while a call
  runs stays `tool_call_progress.output`. Records written before 0.14.0
  carry `output` instead; `eventsOf` and the session view read it as
  `content` (`observe/legacy.ts`), so a persisted log keeps replaying. Per-runtime sources are in
  [runtime-matrix.md](runtime-matrix.md#tool-outcomes).

## Record contracts

```ts
type RecordKind = "frame" | "request" | "response";
// Derivable from field shape (kimi-cli's wire tells them apart by the id),
// but a TS discriminated union needs an explicit discriminant: the one
// deliberate convenience field.

type RawEvent = Frame | RequestRecord | ResponseRecord;  // one record of the stream

interface RecordEnvelope {
  sessionId: string;            // runtime-native; a derived child session carries its own
  agentPath: readonly string[]; // attribution + sub-agent lineage; [] = root
  spanId?: string;              // runtime-native turn id, optional; oar never generates it
  seq: number;                  // total order per stream, cursor anchor; record identity rests on seq alone
  receivedAt: number;           // Unix epoch ms at adapter ingress; best-effort, outside the determinism guarantee
}

interface Frame extends RecordEnvelope {
  kind: "frame";                // runtime verbatim; oar never synthesizes
  body: FrameBody;
}

interface FrameBody {
  type: string;                 // runtime-native discriminator (claude type[/subtype], codex method, pi event type, ACP sessionUpdate)
  native: unknown;              // the frame as the runtime sent it, never trimmed or re-shaped
  events: readonly RuntimeEventBody[];  // what oar read out of the frame, in frame order; [] when oar read nothing
}
// RuntimeEventBody:
//   user_message {input, inputId?, nativeMessageId?, turnId?, evidence} (conversation.md) |
//   text_delta {text, messageId?} | reasoning {content} |
//   tool_call_started {callId, tool, input?} |
//   tool_call_progress {callId, output?} |
//   tool_call_ended {callId, content?: ToolOutputPart[], result?: "ok" | "failed", exitCode?: number | null} |
//   turn_ended {outcome} | usage {usage: {context?, tokens?}} | model {model} |
//   effort {effort} |
//   compaction_started {trigger?} |
//   compaction_ended {outcome: completed | aborted | failed, trigger?, reason?} |
//   retry {attempt, maxAttempts?, delayMs?, reason?} |
//   task_started {taskId, taskType, nativeType?, description?, toolCallId?, childSessionId?, background?, ambient?} |
//   task_updated {taskId, status?, background?, description?, error?} |   // status: pending | running | paused | completed | failed | stopped
//   task_ended {taskId, status: completed | failed | stopped, summary?, outputFile?}
// `events` is a LIST because one frame can say several things (a claude
// assistant message with thinking + text + tool_use is one frame carrying
// three events) and one frame must stay one record: splitting it would
// duplicate `native`, merging frames would lose the runtime's own framing.

interface RequestRecord extends RecordEnvelope {
  kind: "request";
  id: string;
  direction: "toRuntime" | "toApp";
  body: RequestBody;            // prompt | steer | queue {input, inputId?, images?, origin?} | abort | dispose | native {type, native} (toApp, verbatim)
}

interface ResponseRecord extends RecordEnvelope {
  kind: "response";
  requestId: string;            // must point to a request; reverse not guaranteed
  body: ResponseBody;           // accepted {native?} | rejected {code, reason, native?} | answered {native} | exited {code}
}
// accepted/rejected: control answers only "taken over or not".
// answered: oar's own reply to a toApp request (the automatic permission
// grant): an outcome the runtime did not say.
// exited: the process exit, the one outcome the runtime can never say
// itself; answers the dispose request when oar caused it, stands alone
// (requestId "") when the runtime died on its own.
```

The control surface that produces these records (`Session.prompt / steer /
queue / abort / dispose`, `rawEvents(observer, cursor?)`, `records()`,
`graph()`, and the folds) is documented on the contract itself. An
adapter's `prompt / steer / queue / abort` return both records they
appended (`ControlResult`); the `Session` a consumer holds returns them read
(`ControlOutcome`): `kind` is `accepted` or `rejected` (the two answers a
toRuntime control can get), a rejection has its `code` and `reason` at
hand, `seq` is the request's position in the stream (what `awaitTurnEnd`
takes), and `request` / `response` are still the records themselves.
`dispose()` returns void: its request and the `exited` response are read
from the stream like everything else. The turn helpers build on this:
`promptAndWait(session, input, { timeoutMs?, signal? })` prompts and waits
for the runtime's own turn end (aborting when a limit fires, and reporting
that as `interrupted` with the runtime's outcome), and `awaitIdle(session)`
waits for the running turn, if any, to end.

## The Event layer: the consumer face, a projection over the stream

Most consumers want the facts, not records. `Session.events()` delivers
them as flat `Event`s and is the surface to start with; `rawEvents()` and
`records()` are the stream itself, for when the native frame matters.

```ts
type Event = EventBody & RecordEnvelope;      // one attributed fact
type EventBody = RuntimeEventBody | ControlEventBody;
// ControlEventBody, read off request/response records so the consumer
// never handles record kinds:
//   turn_started {requestId, input}                    ← a prompt request
//   control_rejected {requestId, action, code, reason} ← a rejected response
//   app_request {requestId, type}                      ← a toApp request
//   app_answered {requestId}                           ← an answered response
//   exited {code}                                      ← an exited response
```

Which runtimes say which kinds (runtime pages hold the evidence):

- `text_delta`, `reasoning`, `tool_call_started`, `tool_call_ended`,
  `turn_ended`, `usage`, `model`: every shipped adapter.
- `tool_call_progress`: partial output of a running tool. pi
  `tool_execution_update` (the partial result as JSON) [src 0.84.2]; codex
  `item/commandExecution/outputDelta` (`callId` is the item id, `output`
  the delta) [env 0.154.0 schema]; ACP (grok, kimi) a non-terminal
  `tool_call_update` for a known call that carries `rawOutput`, never its
  `content` (kimi streams the call's ARGUMENTS as content while
  `in_progress`). claude streams none.
- `compaction_started`: pi `compaction_start` (`trigger` is pi's reason:
  manual | threshold | overflow); codex `item/started` for a
  `contextCompaction` item (no trigger). Never claude (it reports only the
  boundary after the fact) or ACP.
- `compaction_ended`: pi `compaction_end` (`aborted` → aborted, an
  `errorMessage` → failed with that reason, else completed; `trigger` as
  above); claude `system/compact_boundary` → completed with `trigger` from
  `compact_metadata.trigger` (manual | auto) [sym 2.1.272]; codex
  `item/completed` for the `contextCompaction` item → completed, while the
  deprecated `thread/compacted` notification closes an open compaction only
  when the item did not already (the projection dedupes, so codex never ends
  a compaction twice) [env 0.154.0 schema]. ACP never.
- `retry`: pi `auto_retry_start` and `summarization_retry_scheduled`. No
  other shipped runtime exposes a retry (claude retries silently).
- `task_started` / `task_updated` / `task_ended`: work the runtime tracks
  beside the turn that started it. claude `system/task_started`,
  `task_updated` (its `patch`) and `task_notification` [env 2.1.284]:
  commands (`local_bash` → shell), subagents (`local_agent`, `remote_agent`
  → agent) and MCP calls moved to the background (`mcp_task` → tool), with
  `tool_use_id` as `toolCallId`, `is_backgrounded` as `background` and
  `killed` read as `stopped`; `background_tasks_changed` repeats the live
  set and maps to nothing (a change of `ambient` alone shows only there).
  codex `subAgentActivity` items on the parent thread [env 0.158.0]:
  started → `task_started` (the child thread is `taskId` and
  `childSessionId`, its `/root/name` path the description), interacted →
  `task_updated` running, completed → `task_ended` completed, interrupted →
  `task_ended` stopped. A codex command the model detached itself
  (`nohup … &`) leaves no task. ACP and pi report none. `tasksOf` /
  `reduceTasks` fold them into one row per task.
- `effort`: the reasoning-effort level the runtime reports in effect, in its
  own spelling. codex: the `thread/start` / `thread/resume` reply's
  `reasoningEffort` and `thread/settings/updated`; ACP (grok, kimi): the
  current value of the config option in ACP's `thought_level` category, in
  a handshake answer or a `config_option_update`; pi: `thinkingLevel` on
  `pi/session_opened` and pi's `thinking_level_changed`; cursor: the
  reasoning parameter in the SDK's model selection at open and in each
  run's answer, which the SDK passes through unchecked (codex's case: OAR
  checks the level against the model's menu first). claude never: its
  stream names no level, and its one report (`get_settings`) is read at open
  but not recorded, since it also dumps the user's merged settings. A
  requested `SessionOptions.effort` is never an event of its own: what the
  runtime says back is.
- `app_request` / `app_answered`: any adapter that records `toApp` requests
  (claude `control_request`, codex server requests, ACP permission and
  terminal requests) and, for `app_answered`, one whose automatic reply is
  recorded (the ACP adapters); `type` is the runtime's method or subtype.

The rules that make this a projection and not a second source of truth:

- **Pure derivation.** `eventsOf(record)` (observe/events.ts) reads the
  events out of one record: each entry of a Frame's `events` stamped with
  the frame's envelope, a `turn_started` for a prompt request, an
  `app_request` for a toApp request, a `control_rejected` for a rejected
  response, an `app_answered` for an answered response, an `exited` for the
  exit. `events()` is `rawEvents()` with `eventsOf` applied to every
  record, so a retained log replays into exactly the events the live
  subscription delivered.
- **Several events, one seq.** Events read from one frame share its `seq`,
  `agentPath`, `spanId` and `receivedAt`; `seq` is how a consumer gets back
  to the frame. A record oar read nothing from yields no event.
- **Lossy by design, never lossy in the stream.** An Event carries no
  `native` and no `type`. The Frame underneath keeps both.
- **Coalescing is a consumer option.** `text_delta` arrives at the
  granularity the runtime emits (claude: a whole block per frame; pi and
  codex: token-sized pieces). `events(observer, { coalesceText })` merges
  consecutive text (or readable reasoning) of one agent into one event
  carrying the last piece's envelope (`{ maxHoldMs }` also flushes when the
  stream goes quiet that long). Off by default, so events stay synchronous
  and one-to-one with what was read.
- **Text names its message when the runtime does.** `text_delta.messageId`
  is the runtime's id of the assistant message the text is part of (codex:
  the `agentMessage` item id; claude: the API `message.id`), so two messages
  of one turn stay apart in coalescing and in the session view. pi and the
  ACP runtimes name none, and older records lack it.

## Example 1 · An ordinary turn (claude): both ends of the turn are real records

```
seq=17  ◆ request   root  id=rq-9   prompt "run the tests"
        ↳ the turn's start is this request itself: no synthesized turn_started
seq=18  ◇ response  root  →rq-9     accepted
        ↳ control answers only "taken over": the message was written to claude's stdin
seq=19  ✓ frame     root            assistant   → text_delta "Running them…", tool_call_started call_1
        ↳ ONE frame, one record, two events in the frame's order; `native` is the whole message
seq=20  ✓ frame     root            user        → tool_call_ended call_1
seq=21  ✓ frame     root            result      → turn_ended completed, usage {in:12034, out:512}
        ↳ the turn's end = the runtime's own completion event. rq-9 gets no
          further response: the runtime said the outcome itself
```

## Example 2 · dispose mid-flight: every frame up to the exit is recorded

```
seq=40  ◆ request   root  id=rq-12  dispose
seq=41  ✓ frame     root            tool_result {call:"call_7", …}
        ↳ arrived after the kill was requested, before the process died;
          a settled-gate would swallow it, the stream keeps it
seq=42  ✓ frame     root            result {usage:{in:45231, out:8120}, …}
        ↳ usage is in-stream, with a seq, replayable, never a snapshot
          held beside the stream
seq=43  ◇ response  root  →rq-12    exited {code:143}
        ↳ the one justification for a response: the exit code is an outcome
          the runtime will never say itself; only oar observes it
```

## Example 3 · Dangling request: unobserved outcome stays unobserved

```
seq=57  ◆ request   root  id=rq-30  abort
        ○ absence: oar's own process was SIGKILLed; rq-30 never gets a response
        ↳ an honest record, not a bug: the action was initiated, its outcome
          was not observed. Writing a guessed response after recovery is
          forbidden
```

Non-goal: concurrent control planes and concurrent prompt queueing. No
shipped runtime needs them: kimi-cli returns `INVALID_STATE` with a TODO in
the source, pi has no such form, claude/codex do not expose the semantics.
[src: wire/server.py:644-755]
