# One stream, three record kinds

> Part of the [v2 spec, draft v0.8](README.md). Related design pages:
> [hard problems 5–8](../design/hard-problems.md#the-session-and-event-model),
> [foundations](../design/foundations.md).

**Why this must be fixed first:** v1 pushed the control flow (prompt /
steer / abort / dispose commands and their replies) and the fact flow (what
the runtime actually said) into one `SessionEvent` model — and it is the
control plane that trims, synthesizes, and constrains the facts. Whether a
fact exists depends on whether oar's object model is still alive. That is a
protocol-level defect: until it is fixed, attribution, the session graph,
and the cursor are all built on a foundation that loses facts.

## Evidence A — five concrete defects in shipped v1 code

- **`turn_started` / `turn_ended` are synthesized by oar**: `begin()` /
  `settle()` fan out directly, so the skeleton of the event stream comes
  from "our API was called", not from the runtime.
  [v1: shared/session-kernel.ts:74,78]
- **The control plane swallows facts once closed**: `emit()` is
  `if (!isSettled) fanOut(...)` — runtime events arriving after settle are
  silently dropped. [v1: session-kernel.ts:66-70]
- **The envelope forces `turnId`, so true facts without a turn are lost**:
  pi's 17 session-level events (compaction / queue / retry, …) are dropped
  by the projection. [v1: runtimes/pi/projection.ts:130-149]
- **One answer split across two paths**: the turn outcome lives half in
  the `Turn.outcome` promise and half in the `turn_ended` event; where a
  steer landed lives half in a return value and half in the stream.
  Consumers are forced to join the two. [v1: contracts/session.ts]
- **Query masquerade**: `contextUsage()` is really a cached snapshot of
  the latest usage seen in the stream — no seq, so it can neither be
  aligned with other records nor replayed.
  [v1: runtimes/claude/session.ts:92-93 `latestContextUsage`]

## Evidence B — why the fix is *not* "split into two channels"

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
  records passed through verbatim, the rest wrapped as `SubagentEvent`) —
  same channel, same send. Independent corroboration that the split is by
  obligation, not by channel. [src: subagents/runner.py:393-428]
- Total order is what channel-splitting cannot buy back: two paths share
  no seq, so "did the abort land before or after that tool_result" becomes
  permanently unanswerable.

## The v2 rules

**event** — the runtime's own words. Expects no reply; append-only;
monotonic seq. oar never synthesizes an event. v1's only synthesis case
(turn boundaries) has real replacements in v2: the turn's start *is* the
prompt request itself, and its end is the runtime's own completion event
(claude's `result`, codex's `task_complete`); if a runtime doesn't report
one, it is honestly absent. Since no oar-made facts exist in the stream,
the earlier `origin: "runtime" | "oar"` self-disclosure label has no
reason to exist — the field is deleted entirely.

**request** — an action record that expects an outcome; bidirectional.
app→runtime: prompt / steer / abort / dispose. runtime→app: approvals,
questions, external tools. `direction` survives its deletion test because
toApp request bodies are runtime verbatim with an open vocabulary: the
server must decide "does the app need to answer this" without
understanding the body, and only `direction` makes that possible.

**response** — must point at a request (`requestId`); the reverse is not
guaranteed. A response exists *only* when oar observed an outcome the
runtime will not say itself (e.g. the process exit code after a dispose).
Outcomes the runtime does say — a prompt completing — are answered by its
own events, and oar adds no echoing response; otherwise the synthesized
`turn_ended` returns under a new name. A request without a response is an
honest record: the action was initiated and the outcome was not observed
(crash, oar itself killed). Backfilling a guessed response is forbidden.

Further rules:

- **Control never prunes facts.** All `if (!isSettled) drop`-style gates
  are deleted; whatever the runtime said must enter the stream, even if it
  lands after a span has ended.
- **Control responses answer only "accepted or not".** Final states and
  landing points are always events. Counterexample: kimi-cli leaks the
  turn outcome into `_handle_prompt`'s return value, while the `TurnEnd`
  docstring admits it "may be omitted" when interrupted.
  [src: wire/server.py:644-755; wire/types.py]
- **Turn is demoted from control object to a span on the stream.** The
  envelope no longer forces `turnId`; it becomes an optional `spanId`
  carrying only runtime-native ids (red line in
  [runtime-matrix.md](runtime-matrix.md)) — pi's 17 events are no longer
  dropped.
- **Query is a projection over the stream.** `contextUsage()` is a fold
  over seq-carrying usage events, not a second source of truth.

## Record contracts

```ts
type RecordKind = "event" | "request" | "response";
// kind is theoretically derivable from field shape (kimi-cli's wire
// distinguishes by the presence of id), but TS discriminated unions need
// an explicit discriminant — kept; the only deliberate convenience field
// left after ablation.

interface RecordEnvelope {
  sessionId: string;            // runtime-native; a derived child session carries its own
  agentPath: readonly string[]; // attribution + sub-agent lineage; [] = root
  spanId?: string;              // runtime-native turn id, optional; oar never generates it
  seq: number;                  // total order per stream, cursor anchor; record identity rests on seq alone
  receivedAt: number;           // best-effort observation time, outside the determinism guarantee
}

interface EventRecord extends RecordEnvelope {
  kind: "event";                // runtime verbatim; oar never synthesizes
  body: EventBody;
}

interface EventBody {
  type: string;                 // runtime-native discriminator (claude type[/subtype], codex method, pi event type, ACP sessionUpdate)
  native: unknown;              // the frame as the runtime sent it — never trimmed or re-shaped
  views: readonly EventView[];  // oar's readings of the frame, in frame order; [] when oar has none
}
// EventView: text_delta | reasoning | tool_call_started | tool_call_ended |
// turn_ended {outcome} | usage {context?, tokens?} | model {model}.
// `views` is a LIST because one frame can say several things (a claude
// assistant message with thinking + text + tool_use is one record with
// three views) and one frame must stay one record — splitting it would
// duplicate `native`, merging frames would lose the runtime's own framing.

interface RequestRecord extends RecordEnvelope {
  kind: "request";
  id: string;
  direction: "toRuntime" | "toApp";
  body: RequestBody;            // prompt | steer | queue | abort | dispose | native {type, native} (toApp, verbatim)
}

interface ResponseRecord extends RecordEnvelope {
  kind: "response";
  requestId: string;            // must point to a request; reverse not guaranteed
  body: ResponseBody;           // accepted {native?} | rejected {reason, native?} | answered {native} | exited {code}
}
// accepted/rejected: control answers only "taken over or not".
// answered: oar's own reply to a toApp request (the automatic permission
// grant) — an outcome the runtime did not say.
// exited: the process exit — the one outcome the runtime can never say
// itself; answers the dispose request when oar caused it, stands alone
// (requestId "") when the runtime died on its own.
```

The control surface that produces these records (`Session.prompt / steer /
queue / abort / dispose`, `subscribe(observer, cursor?)`, `records()`,
`graph()`, and the folds `model() / usage() / contextUsage()`) is
documented on the contract itself; a control call returns both records it
appended (`ControlResult`), so the request's `seq` is where the action sits
in the stream.

## Example 1 · An ordinary turn (claude): both ends of the turn are real records

```
seq=17  ◆ request   root  id=rq-9   prompt "run the tests"
        ↳ the turn's start is this request itself — no synthesized turn_started
seq=18  ◇ response  root  →rq-9     accepted
        ↳ control answers only "taken over": the message was written to claude's stdin
seq=19  ✓ event     root            assistant   → text_delta "Running them…", tool_call_started call_1
        ↳ ONE frame, one record, two views in the frame's order; `native` is the whole message
seq=20  ✓ event     root            user        → tool_call_ended call_1
seq=21  ✓ event     root            result      → turn_ended completed, usage {in:12034, out:512}
        ↳ the turn's end = the runtime's own completion event, projected as a view.
          rq-9 gets no further response — the runtime said the outcome itself;
          oar does not restate it
```

## Example 2 · dispose mid-flight: frames v1 swallowed, v2 records in full

```
seq=40  ◆ request   root  id=rq-12  dispose
seq=41  ✓ event     root            tool_result {call:"call_7", …}
        ↳ arrived after the kill was requested, before the process died.
          v1's isSettled gate swallows this (session.ts:185 settles before
          :186 kills)
seq=42  ✓ event     root            result {usage:{in:45231, out:8120}, …}
        ↳ in v1 this usage went only into the latestContextUsage snapshot,
          never into the event stream; in v2 it is in-stream, with a seq,
          replayable
seq=43  ◇ response  root  →rq-12    exited {code:143}
        ↳ the one justification for a response to exist: the process exit
          code is an outcome the runtime will never say itself — only oar
          observes it
```

## Example 3 · Dangling request: unobserved outcome stays unobserved

```
seq=57  ◆ request   root  id=rq-30  abort
        ○ absence — oar's own process was SIGKILLed; rq-30 never gets a response
        ↳ not a bug, an honest record: the action was initiated, its outcome
          was not observed. Writing a guessed response after recovery is
          forbidden
```

Non-goal recorded here: concurrent control planes / concurrent prompt
queueing. No shipped runtime needs it — kimi-cli returns `INVALID_STATE`
with a TODO in the source, pi has no such form, claude/codex do not expose
the semantics. Zero empirical demand. [src: wire/server.py:644-755]
