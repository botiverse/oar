# One stream, three record kinds

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 5-8](../design/hard-problems.md#the-session-and-event-model),
> [foundations](../design/foundations.md).

Control (prompt / steer / queue / withdraw / abort / dispose and their replies) and
facts (what the runtime actually said) are records on one stream, and
control never decides whether a fact exists. A model that pushes both
through control objects lets the control plane trim, synthesize, and
constrain facts, so whether a fact exists depends on whether an object is
still alive. Attribution, the session graph, and the cursor cannot be built
on a stream that loses facts. The five ways such a model loses facts are in
the [decision](../design/decisions.md#control-objects-as-the-event-model-2026-09-03).

## Evidence B: why the fix is not split into two channels

Control and facts share one channel because two paths share no seq: "did
the abort land before or after that tool_result" would become unanswerable.
Every shipped runtime carries both on one channel as well; the vendor
evidence is in the
[decision](../design/decisions.md#separate-channels-for-control-and-facts-2026-09-03).

## The rules

**frame**: the runtime's own words. Expects no reply; append-only;
monotonic seq. oar never synthesizes a frame. The turn's start *is* the
prompt request itself, and its end is the runtime's own completion event
(claude's `result`, codex's `turn/completed`); if a runtime doesn't report
one, it is honestly absent. No oar-made facts exist in the stream, so there
is no origin self-disclosure label.

**request**: an action record that expects an outcome; bidirectional.
app→runtime: prompt / steer / queue / withdraw / abort / dispose. runtime→app:
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

- **Credential configuration values do not enter records.** This is the
  exception to verbatim recording: adapters replace documented credential
  fields with `[redacted]` before the kernel retains or publishes a frame,
  preserving names and other fields. Live observers and replay see the same
  redacted frame; the runtime's configuration is unchanged
  ([Grok MCP evidence](../runtimes/grok.md#session-mcp-servers)). Records a
  host stored before a rule existed are cleaned with `redactRecord` (root and
  `@botiverse/oar/observe`): it applies the current rules to one stored
  record, returns a changed copy only when it changed something, and is safe
  to run over all storage on every start (grok MCP notifications recorded
  before 0.32.1 carry the user's own MCP `env` values). `REDACTION_RULES`
  (same exports) says when and where to run it: `version` goes up whenever a
  rule is added or broadened, so a host rescans stored records only when it
  changes; `frameTypePrefixes` lists the `body.type` prefixes a rule can
  change, and a frame matching none is never changed, so storage can be
  pre-filtered by them.
- **Control never prunes facts.** There is no settled-gate anywhere:
  whatever the runtime said must enter the stream, even if it lands after a
  span has ended.
- **Reachability is read off the stream.** Once the stream holds an
  `exited` response (the runtime is gone) or a `dispose` request (the
  session is being released), every later prompt / steer / queue / withdraw /
  abort request is rejected (`runtime_exited` / `disposed`) by the shared kernel
  before any adapter code runs: no adapter keeps a private "is it alive"
  flag. `dispose` is the one control that still goes through after an
  observed exit: it is recorded and answered `accepted` at once (nothing is
  left to release), so a session whose runtime died on its own still ends
  with an answered dispose rather than a dangling one.
- **Control responses answer only "accepted or not".** Final states and
  landing points are always events. A rejection carries one typed `code`
  (`busy`, `no_active_turn`, `not_queued`, `unsupported`, `runtime_exited`,
  `disposed`, `runtime_refused`, `error`) next to the prose `reason`, so an application
  branches on a word, not on vendor text. `unsupported` means the runtime
  cannot do this control with these inputs (images where it takes none,
  images on a cursor steer); a control a runtime cannot do at all is a
  member the session lacks, never a request that is always rejected: a
  session that cannot steer has no `steer`, so its stream holds no steer
  request.
- **An interrupted process can still exit before replying.** Claude and
  Codex answer pending aborts `rejected: runtime_exited` when that happens,
  once per request. Claude's late `control_response` bytes remain a frame,
  not a second response. If the interrupted turn has not ended within ten
  seconds, OAR terminates the process. On POSIX this sends SIGTERM to its
  process group, then SIGKILL after the normal kill grace period (another
  ten seconds by default, `OAR_KILL_GRACE_MS`), which also reaches its
  descendants that left the group (claude's Bash tool commands); on Windows
  it force-terminates the process tree with `taskkill /T /F`, including any
  launcher and the runtime behind it.
  An interrupt acknowledgement does not cancel this fallback; a turn end
  does. A native refusal cancels only that abort attempt; it must not kill
  work the runtime refused to interrupt. Process exit is the observer's
  `failed: runtime_exited` turn end;
  OAR invents neither a `turn_ended` frame nor a `timeout` rejection. Hosts
  resume the native session to continue after this fallback.
- **Spawned processes belong to the host's lifetime.** One synchronous Node
  `exit` hook kills OAR's still-running sessions, probes (inventory and
  account usage), updaters, logins and ACP terminals. POSIX sends SIGKILL to
  their process groups, and to the descendants of each child still running
  (read from the process table then, so not one already re-parented away
  from it) and their groups; Windows synchronously runs `taskkill /T /F` for each
  live child to include its descendants (bounded to ten seconds per call,
  falling back to the direct child on failure). Windows cannot reclaim a
  tree through a launcher that already exited: its pid may be reused. This is a final
  fallback, not a substitute for disposal: no graceful hooks run. Node
  does not emit `exit` for an unhandled terminating signal, including
  SIGKILL, so hosts must handle ordinary termination signals themselves.
  Processes spawned internally by an embedded SDK are outside this registry.
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
  arriving before the root's ([env] 0.149.0), and the child's usage total
  would otherwise overwrite the root's under `agentPath []`. Scope a
  fold to a child by passing its `sessionId` (`usageOf(records, sessionId)`).
- **A tool's input is the latest one the runtime reported.**
  `tool_call_started.input` is what the opening frame said, and stays so. A
  runtime that sends the arguments later (an ACP `tool_call_update` whose
  `rawInput` differs from the input last read for the call: opencode's
  opening `tool_call` carries only `cwd` or nothing, kimi's no `rawInput`)
  adds a `tool_call_input` holding the whole input in the same form,
  replacing the earlier one, never a delta. An unchanged repeat adds none;
  on the frame that ends the call it comes before `tool_call_ended`, and
  none follows the end. The session view's tool part keeps the latest, and
  `classifyTool` is handed that one.
- **Tool outcomes are the runtime's.** `tool_call_ended.result` (`"ok"` |
  `"failed"`) is present only when the runtime explicitly reports the
  outcome; oar never infers it from output, exit codes, or timing.
  `exitCode` follows the same rule for the process status of a command the
  runtime ran: present only when the runtime reported one (codex, grok,
  antigravity, cursor), `null` when it reported a signal exit, absent
  otherwise (claude and pi report none).
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
  `content` (`observe/legacy.ts`), so a persisted log keeps replaying.
  Per-runtime sources, and the cut the ACP adapters apply to long text
  parts, are in [runtime-matrix.md](runtime-matrix.md#tool-outcomes).

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
  native: unknown;              // as sent, except credential-field values redacted before recording
  events: readonly RuntimeEventBody[];  // what oar read out of the frame, in frame order; [] when oar read nothing
}
// RuntimeEventBody:
//   user_message {input, inputId?, nativeMessageId?, turnId?, evidence} (conversation.md) |
//   text_delta {text, messageId?} | reasoning {content} |
//   tool_call_started {callId, tool, input?} |
//   tool_call_input {callId, input} |
//   tool_call_progress {callId, output?} |
//   tool_call_ended {callId, content?: ToolOutputPart[], result?: "ok" | "failed", exitCode?: number | null} |
//   turn_ended {outcome} | usage {usage: {context?, tokens?: {input, output, cacheRead?, cacheWrite?}}} | model {model} |
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
  body: RequestBody;            // prompt | steer | queue {input, inputId?, images?, origin?} | withdraw {inputId} | abort | dispose | native {type, native} (toApp, verbatim)
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
queue / withdraw / abort / dispose`, `rawEvents(observer, cursor?)`, `records()`,
`graph()`, and the folds) is documented on the contract itself. A `prompt`
while a turn runs is rejected `busy`, never queued: a session has one
control plane and at most one active turn
([decision](../design/decisions.md#concurrent-control-planes-and-prompts-2026-09-03)).
`steer` and `withdraw` are optional: their presence is the capability
([which sessions have them](runtime-matrix.md#session-controls)), and
`steerOrQueue` and `deliver` queue where `steer` is absent. `queue` is on
every session; `capabilities.queue.durable` says whether held input
survives a restart. See [withdrawing held input](#withdrawing-held-input).
An adapter's `prompt / steer / queue / withdraw / abort` return
both records they appended (`ControlResult`); the `Session` a consumer holds
returns them read (`ControlOutcome`): `kind` is `accepted` or `rejected`
(the two answers a toRuntime control can get), a rejection has its `code`
and `reason` at hand, `seq` is the request's position in the stream (what `awaitTurnEnd`
takes), and `request` / `response` are still the records themselves.
`dispose()` returns void: its request and the `exited` response are read
from the stream like everything else. The turn helpers build on this:
`promptAndWait(session, input, { timeoutMs?, signal? })` prompts and waits
for the runtime's own turn end (aborting when a limit fires, and reporting
that as `interrupted` with the runtime's outcome), and `awaitIdle(session)`
waits for the running turn, if any, to end.

## Withdrawing held input

`Session.withdraw(inputId)` takes back an input a `queue` request left in
OAR's own held queue, before it is sent. It is its own operation targeting
earlier input ([input cancellation](../runtimes/input-cancellation.md#consequences-for-oar-and-rao)):
a `toRuntime` request `withdraw {inputId}` recorded through the kernel's
control path, so a disposed or exited session refuses it like any control.
Its answer is one of two:

- `accepted`: the held entry was removed before it was sent, and the caller
  owns the input again. `events()` reads it as `input_withdrawn {requestId,
  inputId}`.
- `rejected` `not_queued`: no held input with this `inputId` is waiting. It
  was already sent to the runtime, never queued in this session, or already
  withdrawn; the stream before the withdraw says which.

The adapter decides and removes in one synchronous step, and its drain takes
an entry off the same queue in one step before sending it, so a withdraw
racing the drain either removes the entry first or finds it gone: an input
is never both sent and withdrawn. The queue request and its `accepted`
response stay in the stream as they were; the withdrawal is a fact of its
own. A withdrawn input can be queued again under the same `inputId` (edit)
or sent with `deliver` (send now): a new attempt, read by the ordinary
rules ([conversation](conversation.md#withdrawing-held-input)).

`withdraw` exists where OAR holds the queue: claude, pi, cursor, kimi, grok,
antigravity and opencode. codex holds its queue natively, and its
`thread/queue/delete` is experimental and not live-verified, so a codex
session has no `withdraw`.

```
seq=30  ◆ request   root  id=rq-14  queue "and then this" inputId=in-7
seq=31  ◇ response  root  →rq-14    accepted
        ↳ held by the adapter: a turn is still running
seq=32  ◆ request   root  id=rq-15  withdraw inputId=in-7
seq=33  ◇ response  root  →rq-15    accepted
        ↳ removed before the drain reached it; rq-14 and its answer stand
seq=34  ✓ frame     root            result      → turn_ended completed
        ↳ nothing is drained: no turn follows for in-7
```

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
//   input_withdrawn {requestId, inputId}               ← an accepted withdraw response
//   control_rejected {requestId, action, code, reason} ← a rejected response
//   app_request {requestId, type}                      ← a toApp request
//   app_answered {requestId}                           ← an answered response
//   exited {code}                                      ← an exited response
```

Which runtimes say which kinds (runtime pages hold the evidence):

- `text_delta`, `reasoning`, `tool_call_started`, `tool_call_ended`,
  `turn_ended`, `usage`, `model`: every shipped adapter, except that
  antigravity sent no reasoning and no usage in any probe ([env]
  agy_acp_server 1.2.1).
- `tool_call_progress`: partial output of a running tool. pi
  `tool_execution_update` (the partial result as JSON) [src 0.84.2]; codex
  `item/commandExecution/outputDelta` (`callId` is the item id, `output`
  the delta) [env 0.154.0 schema]; ACP (grok, kimi) a non-terminal
  `tool_call_update` for a known call that carries `rawOutput`, never its
  `content` (kimi streams the call's ARGUMENTS as content while
  `in_progress`). claude streams none; cursor's `shell-output-delta` is
  recorded with no event.
- `tool_call_input`: arguments reported after the call started. ACP (grok,
  kimi, opencode, antigravity) a `tool_call_update` for a call that has not
  ended, carrying a `rawInput` that differs from the input last read for
  it: opencode's arguments (the opening frame has `{cwd}` or `{}`), kimi's
  full `rawInput` after its streamed `content` chunks, grok's update adding
  `is_background` and `variant` to `{command, description}`. No other
  shipped adapter emits it.
- `compaction_started`: pi `compaction_start` (`trigger` is pi's reason:
  manual | threshold | overflow); codex `item/started` for a
  `contextCompaction` item (no trigger). Never claude (it reports only the
  boundary after the fact), cursor (its SDK drops the `summary` updates) or
  ACP.
- `compaction_ended`: pi `compaction_end` (`aborted` → aborted, an
  `errorMessage` → failed with that reason, else completed; `trigger` as
  above); claude `system/compact_boundary` → completed with `trigger` from
  `compact_metadata.trigger` (manual | auto) [sym 2.1.272]; codex
  `item/completed` for the `contextCompaction` item → completed, while the
  deprecated `thread/compacted` notification closes an open compaction only
  when the item did not already (the projection dedupes, so codex never ends
  a compaction twice) [env 0.154.0 schema]. Cursor and ACP never.
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
  (`nohup … &`) leaves no task. ACP, pi and cursor report none. `tasksOf` /
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
  response, an `input_withdrawn` for an accepted withdraw response, an
  `app_answered` for an answered response, an `exited` for the exit. A
  response names only its `requestId`, so the reading takes the toRuntime
  requests seen before it (`controlActionsOf(records)` builds them from a
  log). `events()` is `rawEvents()` with `eventsOf` applied to every
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
  of one turn stay apart in coalescing and in the session view. pi, cursor
  and the ACP runtimes name none, and older records lack it.

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
