# One stream, three record kinds

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 5-8](../design/hard-problems.md#the-session-and-event-model),
> [foundations](../design/foundations.md).

**Why this must be fixed first:** a design that pushes the control flow
(prompt / steer / queue / abort / dispose commands and their replies) and the fact
flow (what the runtime actually said) through one model lets the control
plane trim, synthesize, and constrain the facts: whether a fact exists then
depends on whether the object model is still alive. That is a protocol-level
defect: attribution, the session graph, and the cursor cannot be built on a
foundation that loses facts.

## Evidence A: five ways a control-shaped event model loses facts

- **Synthesized turn boundaries**: if `begin()` / `settle()` fan out
  `turn_started` / `turn_ended` themselves, the skeleton of the stream comes
  from "our API was called", not from the runtime.
- **A closed control plane swallows facts**: an `if (!isSettled) fanOut(...)`
  gate silently drops runtime events arriving after settlement.
- **A mandatory `turnId` loses facts without a turn**: pi's session-level
  events (compaction / queue / retry, …) belong to no turn and would have
  nowhere to go.
- **One answer split across two paths**: a turn outcome half in a promise and
  half in an event, a steer landing half in a return value and half in the
  stream, forces every consumer to join the two.
- **Query masquerade**: a `contextUsage()` that is a cached snapshot of the
  latest usage seen carries no seq, so it can neither be aligned with other
  records nor replayed.

## Evidence B: why the fix is *not* "split into two channels"

Every shipped runtime does this in a single channel:

- kimi-cli's entire message algebra is one union whose discriminator is
  "does it expect a reply": `type WireMessage = Event | Request`, with the
  `Request` docstring verbatim "a message that expects a response". On the
  wire the difference is only message shape (event has no id / request has
  an id); one `_write_queue`, one `wire.jsonl` holds everything.
  [src: kimi-cli@cbc15c0 wire/types.py; wire/jsonrpc.py:49-56,174-204;
  wire/server.py; wire/file.py]
- KLIP-12 explicitly lists "no new transport channel" as a non-goal.
  [doc: klip-12, Implemented]
- codex is isomorphic: `OutgoingMessage` carries notification / request /
  response on one connection.
  [src: codex-rs/app-server/src/outgoing_message.rs:1-80]
- kimi-cli routes sub-agent records **by obligation** (request-class
  records passed through verbatim, the rest wrapped as `SubagentEvent`):
  same channel, same send. Independent corroboration that the split is by
  obligation, not by channel. [src: subagents/runner.py:393-428]
- Total order is what channel-splitting cannot buy back: two paths share
  no seq, so "did the abort land before or after that tool_result" becomes
  permanently unanswerable.

## The rules

**frame**: the runtime's own words. Expects no reply; append-only;
monotonic seq. oar never synthesizes a frame. Turn boundaries, the one
tempting synthesis case, have real replacements: the turn's start *is* the
prompt request itself, and its end is the runtime's own completion event
(claude's `result`, codex's `turn/completed`); if a runtime doesn't report
one, it is honestly absent. No oar-made facts exist in the stream, so
there is no origin self-disclosure label.

**request**: an action record that expects an outcome; bidirectional.
app→runtime: prompt / steer / queue / abort / dispose. runtime→app: approvals,
questions, external tools. `direction` is needed because toApp request
bodies are runtime verbatim with an open vocabulary: the
server must decide "does the app need to answer this" without
understanding the body, and only `direction` makes that possible.

**response**: must point at a request (`requestId`); the reverse is not
guaranteed. A response exists *only* when oar observed an outcome the
runtime will not say itself (e.g. the process exit code after a dispose).
Outcomes the runtime does say (a prompt completing) are answered by its
own frames, and oar adds no echoing response; otherwise the synthesized
`turn_ended` returns under a new name. A request without a response is an
honest record: the action was initiated and the outcome was not observed
(crash, oar itself killed). Backfilling a guessed response is forbidden.

Further rules:

- **Control never prunes facts.** There is no settled-gate anywhere:
  whatever the runtime said must enter the stream, even if it lands after a
  span has ended.
- **Reachability is read off the stream.** Once the stream holds an
  `exited` response (the runtime is gone) or a `dispose` request (the
  session is being released), every later prompt / steer / queue / abort
  request is rejected (`runtime exited` / `session disposed`) by the shared
  kernel before any adapter code runs: no adapter keeps a private "is it
  alive" flag. `dispose` is the one control that still goes through after an
  observed exit: it is recorded and answered `accepted` at once (nothing is
  left to release), so a session whose runtime died on its own still ends
  with an answered dispose rather than a dangling one.
- **Control responses answer only "accepted or not".** Final states and
  landing points are always events. Counterexample: kimi-cli leaks the
  turn outcome into `_handle_prompt`'s return value, while the `TurnEnd`
  docstring admits it "may be omitted" when interrupted.
  [src: wire/server.py:644-755; wire/types.py]
- **A turn is a span on the stream, not a control object.** The envelope
  carries an optional `spanId` holding only runtime-native ids (red line in
  [runtime-matrix.md](runtime-matrix.md)); records without a native turn id,
  such as pi's session-scoped frames, simply have none.
- **Query is a projection over the stream.** `model()`, `usage()`, and
  `contextUsage()` are folds over the retained records and return
  `{ value, seq }`; `seq` is the last record consumed, or `-1` before any
  record.

## Record contracts

```ts
type RecordKind = "frame" | "request" | "response";
// kind is theoretically derivable from field shape (kimi-cli's wire
// distinguishes by the presence of id), but TS discriminated unions need
// an explicit discriminant, kept as the one deliberate convenience field.

type RawEvent = Frame | RequestRecord | ResponseRecord;  // one record of the stream

interface RecordEnvelope {
  sessionId: string;            // runtime-native; a derived child session carries its own
  agentPath: readonly string[]; // attribution + sub-agent lineage; [] = root
  spanId?: string;              // runtime-native turn id, optional; oar never generates it
  seq: number;                  // total order per stream, cursor anchor; record identity rests on seq alone
  receivedAt: number;           // best-effort observation time, outside the determinism guarantee
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
// RuntimeEventBody: text_delta | reasoning | tool_call_started |
// tool_call_progress {callId, output?} |
// tool_call_ended {callId, output?, result?: "ok" | "failed"} |
// turn_ended {outcome} | usage {context?, tokens?} | model {model} |
// compaction_started {trigger?} |
// compaction_ended {outcome: completed | aborted | failed, trigger?, reason?} |
// retry {attempt, maxAttempts?, delayMs?, reason?}.
// `events` is a LIST because one frame can say several things (a claude
// assistant message with thinking + text + tool_use is one frame carrying
// three events) and one frame must stay one record; splitting it would
// duplicate `native`, merging frames would lose the runtime's own framing.
// `Session.events()` delivers those three as three Events sharing the seq.

interface RequestRecord extends RecordEnvelope {
  kind: "request";
  id: string;
  direction: "toRuntime" | "toApp";
  body: RequestBody;            // prompt | steer | queue | abort | dispose | native {type, native} (toApp, verbatim)
}

interface PromptLineage { runtime: string; sessionId: string; }
// RequestBody's prompt variant is { kind: "prompt"; input: string;
// lineage?: PromptLineage }. The host pointer is copied verbatim and never
// interpreted by oar; it identifies the prior session continued by a new
// session's first prompt (external compaction).

interface ResponseRecord extends RecordEnvelope {
  kind: "response";
  requestId: string;            // must point to a request; reverse not guaranteed
  body: ResponseBody;           // accepted {native?} | rejected {reason, native?} | answered {native} | exited {code}
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
`graph()`, and the folds `model() / usage() / contextUsage()`) is
documented on the contract itself; `prompt / steer / queue / abort` return
both records they appended (`ControlResult`), so the request's `seq` is
where the action sits in the stream. `dispose()` returns void: its request
and the `exited` response are read from the stream like everything else.
Each query returns `{ value, seq }`, with `seq` identifying the last record
consumed by its fold (or `-1` before any record). A `tool_call_ended` event may
carry `result: "ok" | "failed"` only when the runtime explicitly reports the
outcome; oar never infers it from output, exit codes, or timing. When no
runtime outcome is present, the key is absent.
The folds, and `awaitTurnEnd`, scope to the ROOT session: a derived child
session's records (own `sessionId`, a node in `graph()`) never satisfy
them. On codex the child's `turn/completed` was observed arriving before
the root's ([env] 0.149.0), and the child's cumulative usage would
otherwise overwrite the root's under `agentPath []`. Scope a fold to a
child by passing its `sessionId` (`usageOf(records, sessionId)`).

## The Event layer: the consumer face, a projection over the stream

Most consumers do not want records; they want the facts. `Session.events()`
delivers them as flat `Event`s, and it is the surface to start with;
`rawEvents()` and `records()` are the stream itself, for when the native
frame matters.

```ts
type Event = EventBody & RecordEnvelope;      // one attributed fact
type EventBody = RuntimeEventBody | ControlEventBody;
// ControlEventBody, read off request/response records so the consumer
// never handles record kinds:
//   turn_started {requestId, input, lineage?}   ← a prompt request
//   control_rejected {requestId, action, reason} ← a rejected response
//   app_request {requestId, type}                ← a toApp request
//   app_answered {requestId}                     ← an answered response
//   exited {code}                                ← an exited response
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
  `contextCompaction` item (no trigger). claude never: it reports only the
  boundary after the fact. ACP never.
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
- `app_request` / `app_answered`: any adapter that records `toApp` requests
  (claude `control_request`, codex server requests, ACP permission and
  terminal requests) and, for `app_answered`, one whose automatic reply is
  recorded (the ACP adapters); `type` is the runtime's method or subtype.

The rules that make this a projection and not a second source of truth:

- **Pure derivation.** `eventsOf(record)` (observe/events.ts) reads the
  events out of one record: each entry of a Frame's `events` stamped with
  the frame's envelope, a `turn_started` for a prompt request, an
  `app_request` for a toApp request, a `control_rejected` for a rejected
  response, an `app_answered` for an answered response, an `exited` for
  the exit.
  `events()` is `rawEvents()` with `eventsOf` applied to every record, so a
  retained log replays into exactly the events the live subscription
  delivered.
- **Several events, one seq.** Events read from one frame share its `seq`,
  `agentPath`, `spanId` and `receivedAt`; `seq` is how a consumer gets back
  to the frame. A record oar read nothing from yields no event.
- **Lossy by design, never lossy in the stream.** An Event carries no
  `native` and no `type`. The Frame underneath keeps both, so nothing is
  lost by choosing the consumer face.
- **Coalescing is a consumer option.** `text_delta` arrives at the
  granularity the runtime emits (claude: a whole block per frame; pi and
  codex: token-sized pieces). `events(observer, { coalesceText })` merges
  consecutive text (or readable reasoning) of one agent into one event
  carrying the last piece's envelope; off by default, so events stay
  synchronous and one-to-one with what was read.

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
        ↳ the turn's end = the runtime's own completion event, projected as a turn_ended event.
          rq-9 gets no further response: the runtime said the outcome itself;
          oar does not restate it
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
        ↳ the one justification for a response to exist: the process exit
          code is an outcome the runtime will never say itself; only oar
          observes it
```

## Example 3 · Dangling request: unobserved outcome stays unobserved

```
seq=57  ◆ request   root  id=rq-30  abort
        ○ absence: oar's own process was SIGKILLed; rq-30 never gets a response
        ↳ not a bug, an honest record: the action was initiated, its outcome
          was not observed. Writing a guessed response after recovery is
          forbidden
```

Non-goal recorded here: concurrent control planes / concurrent prompt
queueing. No shipped runtime needs it: kimi-cli returns `INVALID_STATE`
with a TODO in the source, pi has no such form, claude/codex do not expose
the semantics. Zero empirical demand. [src: wire/server.py:644-755]
