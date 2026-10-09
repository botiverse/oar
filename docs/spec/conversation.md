# Inputs and conversation projection

An input is a logical user submission; a request is one delivery attempt.
`prompt`, `steer`, `queue`, and `steerOrQueue` accept an optional
`{ inputId }` UUID. Built-in sessions generate one when absent and record it on
input request bodies. `steerOrQueue` preserves it across steer rejection and
queue fallback; each attempt has its own request ID. Custom adapters must copy
`InputOptions.inputId` into the request body. Older records without an input ID
remain readable, but their separate attempts cannot be merged reliably.

## Delivering input from the host

`Session.deliver(input, { when?, origin? })` is for input the host sends on
the agent's behalf, such as a subagent's result, a finished job or a message
from elsewhere. It chooses the control from the session's status and keeps
one `inputId` across attempts:

| `when` | Session idle | Session running |
| --- | --- | --- |
| `now` (default) | `prompt`: a new turn, so an idle agent wakes | `steer`, or `queue` when the session has no `steer` |
| `after_turn` | `prompt` | `queue` |
| `when_idle` | `prompt` | waits until idle, then `prompt` |

A `prompt` refused `busy` (a turn opened between the status read and the
prompt) and a `steer` refused because the turn just ended (`no_active_turn`,
or the runtime's own refusal once the status shows that turn is over, as
codex answers a steer that reaches it after the turn) are retried as the new
state requires. A steer refused `unsupported` (images on a cursor steer) is
queued instead. `steerOrQueue` stays as the running half
of `now`; unlike it, `deliver` never queues into an idle session, where some
runtimes would hold the input without starting a turn. Queueing, batching,
priority and persistence stay with the host's own delivery layer, which
calls `deliver` for the last step.

`InputOptions.origin` (`{ kind: "user" | "notification" | "automation", source? }`)
says who an input comes from. It is recorded on the request body, never sent
to the runtime, and `ConversationInput.origin` carries it from the latest
request, so a UI can show injected input apart from what a person typed.

UUIDs are required because Claude's native input identity uses UUIDs. A supplied
ID must represent exactly one logical input, including retries of that input;
reusing it for a different input merges those submissions by design. Do not
resubmit an accepted input unless the stream later reports it dropped
([Dropped input](#dropped-input)), which hands it back to the caller. OAR
generates identity, not delivery evidence.

## Images

`prompt`, `steer` and `queue` accept `input: ""` when at least one image
is present and that control supports images. With no images (omitted or
`[]`), exactly `""` is rejected `unsupported`, reason
`empty input: give text or images`. The request is still recorded, nothing
is sent to the runtime, and the caller keeps ownership. Whitespace is not
trimmed. Image-only requests and their `turn_started.input` retain `""`;
OAR adds no placeholder prompt.

`InputOptions.images` hands image files (by absolute path) to the runtime with
the input, as its own image content: claude and ACP get base64 `image` blocks,
codex `localImage` paths, pi `ImageContent`, cursor the SDK's
`{ data, mimeType }` images (a cursor steer takes text only). The request
body records the paths verbatim (`images: [{ path }]`), never the bytes, and
`ConversationInput.images` carries them from the latest attempt, so a UI can
show what the user sent next to the text. `capabilities.images` says whether
the runtime takes images at all (ACP: what `initialize` advertised, unless a
profile knows better from a live probe, as grok's does). An input
whose images cannot go (no image input, not a png/jpeg/gif/webp, unreadable)
is rejected whole, `unsupported` or `error`, before it reaches the runtime.
A custom runtime keeps the same rule with `inputImagesRefusal` or
`withInputImages` from `@botiverse/oar/kernel`; `scriptedRuntime` does.
Native echoes (`user_message.input`) remain text only.

## Native observations

`user_message` is a runtime event carried by a real frame, with `input`, optional
`inputId`, `nativeMessageId`, `turnId`, and `evidence`:

- `acknowledged`: Claude's replay-user-message acknowledgement. Its UUID is
  supplied on stdin and echoed on stdout. Adapter-held queued inputs retain it.
- `turn_item`: Codex's `item/started` user message. `clientUserMessageId` is sent
  with prompt/steer/queue; `item.clientId` links the item to the input. The
  native item ID and turn ID are retained. Item completion does not create a
  second user message event.
- `conversation`: Pi's user `message_start`, and cursor's
  `user-message-appended` for a delivered steer. There is no proven native
  request association, so `inputId` is absent. Template expansion and
  duplicate text make text-based matching unsafe.

No evidence kind promises model consumption or semantic effect. Request
acceptance and native observation are independent facts. The ACP runtimes
(grok, kimi, antigravity, opencode) carry logical input identity only; no native
message correlation has been verified for them. Raw payloads remain
unmodified on frames. OAR never adds markers to a user's input text to
correlate it, and never derives a universal "consumed" event from turn
ends, text matching or native queue changes (pi's
`queue_update`); runtime evidence per runtime is in
[steer delivery](../runtimes/steer-delivery.md).

## Browser-safe reducer

`@botiverse/oar/observe` exports:

```ts
let state = initialConversation();
state = reduceConversation(state, record, streamId);
for (const update of state.updates) {
  // kind: "input" → upsert one bubble using update.input.id
  // kind: "event" → render the ordinary agent/tool event
}
```

`state.inputs` contains logical inputs, every attempt's original request and
observed response, and native observations. `state.updates` contains only the
changes from the most recently folded record. Input states are `pending`,
`accepted`, `rejected`, `withdrawn` (taken back before it was sent),
`dropped` (ownership returned by the evidence below), or `untracked` (a native echo without an observed request).
Among attempts after the latest accepted withdrawal or drop, an accepted
attempt wins over later refusals; otherwise the latest attempt
sets the state. A missing response remains pending: neither exceptions nor a
turn end manufacture a refusal or consumption receipt.

Responses use request IDs, scoped to stream instance, native session and agent
path. Input UUIDs use native session and agent path. Echoes arriving before the
response, or even before a retained request, update the same input. Native
message IDs deduplicate correlated replay. Unlinked native user messages are
returned as event updates; consumers decide whether to display them, without
pretending they acknowledge a particular request. The reducer omits duplicate
`turn_started` bubbles and input-rejection notices because input updates carry
those facts; other control events remain visible.

Pass a distinct `streamId` each time a runtime Session is opened or resumed:
OAR seq restarts at zero. Persist it alongside records. The reducer skips already
folded seq values within each stream, allowing history snapshots and buffered
live pushes to overlap safely. UUIDs can still link native echoes across resume.
Inputs do not cross native sessions or agent paths even when IDs are equal.

`conversationOf(records)` folds one stream. `observeConversation(session,
listener, cursor?)` folds the retained prefix and continues live using the same
reducer; a cursor suppresses prefix callbacks without losing their state. Save
raw records, not maps or Promise results, to reproduce the view after restart;
persistence belongs to the application
([application data ownership boundary](../design/foundations.md#replay-boundary)).

Rao uses this reducer over its persisted records. It shows input requests
immediately and hides routine success badges. It must not infer completion of
all steering inputs from `turn_ended`. Taking back held input is `withdraw`
(below); a runtime discarding input is `input_dropped`.

Evidence: [local steer identity probes](../runtimes/steer-delivery.md). Regression
coverage includes pure reducer cases, mock fallback, and Codex/Claude native
harnesses with a local scripted provider.

## Session view message grouping

`reduceSessionView` and `viewOf` project the records into inputs and turn
segments for a chat surface ([design](../design/chat-ui.md)). Each segment
contains sections attributed to a lane: `(sessionId, agentPath)`.

A named message stays in one part of each content kind. `text_delta` and
readable `reasoning` carrying a `messageId` append to the existing text or
reasoning part with that ID in the same lane and current segment, wherever
it sits. Sections and parts keep their order of first appearance. For
example, child `A1`, root `B1`, child `A2`, root `B2`, with one message ID
per lane, render as child `A1A2` then root `B1B2`. Equal IDs in different
lanes never join. `ViewPart.messageId` preserves the native identity on both
text and reasoning parts.

An input entering mid-turn still seals the current segment. The same
message continuing after that boundary starts a new part in the new
segment; it never appends above the input. A pending input seals only when
it enters the transcript, according to the input rules above.

Tools, notices and text or reasoning without a `messageId` keep their
existing stream order and lane-switch sections. Without an ID (including
Pi and ACP text), interleaved lanes can still fragment a message. Redacted
and empty reasoning remain separate lifecycle-only parts; they neither
replace readable reasoning nor invent text. This grouping changes only the
view: the records and flat events retain their original order.

## Dropped input

`input_dropped {inputId, reason: "turn_interrupted" | "runtime_refused"}` is a runtime event.
Only an adapter with native evidence of discard emits it, on the frame
that proves the discard. A turn ending alone says nothing about unread input.
Codex emits it on an interrupted root `turn/completed`, before `turn_ended`,
for accepted steers to that turn with no user-message echo. It does not
apply to Codex's durable queue, another turn, or an echoed steer.
[Runtime evidence](../../experiments/input-interruption-2026-10-08.md)
distinguishes runtimes that retain input and the remaining Grok ambiguity.

ACP steering is accepted when written, since some runtimes answer the RPC
only when the whole turn ends. If the runtime later refuses that RPC, its
error frame carries `input_dropped` with `reason: "runtime_refused"`. The
original accepted response remains, and the refusal does not fail or end
the active turn, even when it arrives after that turn has already ended.
A successful steer that replaces the native prompt (Grok `sendNow`) still
contributes its own native turn outcome.

The conversation reducer sets the input's state to `dropped` and its `reason`
to the event's reason. The caller owns that input again and may resend it.
Earlier accepted responses and native observations remain facts in
`attempts` and `observations`. A later delivery attempt using the same
`inputId` starts fresh, without an earlier accepted attempt keeping the new
attempt accepted; its old top-level drop reason disappears. Reducer state
retains the attempt boundary in `drops` so incremental and replay folds agree.

An `exited` response also settles inputs still waiting in that stream and
session lineage: `dropped`, with `reason: "runtime_exited"`. This includes
held queues and accepted or unanswered steers still awaiting an echo.
A child's exit does not settle its parent's inputs. Streams that place
inputs at their request (ACP, Pi, Cursor) have no such pending tray.
This fold does not synthesize a runtime event or a second control response.
**`runtime_exited` means no read was observed before exit**, not proof the
runtime never read or saved the input. In particular, Codex's durable queue
may survive in its native session. Check the resumed transcript before
resending when duplication matters; death returns control, not certainty.
A later correlated echo, including on resume, replaces an exit-only drop
with the recorded delivery state if no new attempt intervened. It clears
the drop reason and updates the already placed bubble without duplicating
it; the original exit remains in the record stream.

## Withdrawing held input

`Session.withdraw(inputId)`, where the session has it, takes back an input
held for a later turn before it is sent
([record stream](record-stream.md#withdrawing-held-input)). The reducer
adds the withdraw request to the input's `attempts` (it is never a bubble of
its own) and reads its answer:

- An accepted withdraw makes the input `withdrawn`. Its queue attempt and
  that attempt's `accepted` response stay as they were.
- A withdraw still unanswered, or refused `not_queued`, changes nothing: the
  input keeps the state its delivery attempts give it.
- Only delivery attempts after the latest accepted withdraw count. A later
  `queue` of the same `inputId` (edit) or a `deliver` (send now) makes the
  input `pending`, then `accepted` or `rejected`, by the rules above.
- A withdraw of an input the reducer never saw adds no input. Its answer
  stays an ordinary event update (`input_withdrawn`, or `control_rejected`
  with action `withdraw`).

Coverage: [reducer cases](../../tests/withdraw-events.test.ts), one test per
adapter, and the `session.withdraw-before-dispatch` sea-trial case.

## Where an input enters the session view

`reduceSessionView` ([chat UI](../design/chat-ui.md)) places each input in
`messages` where the runtime took it, as far as the stream shows:

- A `prompt` enters at its request; its turn opens below it.
- A `steer` or `queue` enters at its first `user_message` carrying its
  `inputId`, and seals the open turn segment there. Codex holds a steer until
  its current step ends, so replies to earlier input come before it. Until
  then the input is in `SessionView.pendingInputs` (request order), for a
  host to show apart, above the composer for instance. A queued input's echo
  comes as the runtime drains it, so it sits before the turn it starts, even
  in a later stream after resume.
- Whether a stream echoes is read off the stream itself: once it has carried
  a `user_message` with an `inputId` (the echo of the first prompt, on codex
  and claude), later steers and queues wait for their echo. A stream that
  never has (the ACP runtimes echo nothing; pi's and cursor's echoes carry
  no `inputId`) places them at their request, the best fact it has. No
  capability flag or runtime name takes part.
- A rejected input enters where it was refused. If a retry of the same
  input (`deliver`, `steerOrQueue`) must wait for its echo, it leaves
  `messages` for `pendingInputs` again.
- A dropped input leaves `pendingInputs` and enters `messages` at the drop
  event or exit, just as a rejection enters at its refusal.
- An input never echoed stays pending after a turn ends unless explicit
  discard or exit evidence settles it. OAR does not infer discard or a
  position from a turn end or matching text.
- A withdrawn input leaves `pendingInputs`, and `messages` too on a stream
  that placed it at its request. The segment that request sealed stays
  sealed: content folded since sits on either side of where the input was,
  and joining the two would be a merge the stream never said. Queued again,
  it enters by the rules above, at its new request or echo.

Records already folded in a stream (same `streamId`, `seq` not past the
cursor) leave the view unchanged, as they leave the conversation.

Evidence: a real codex run that steers three times while the agent sleeps,
replayed in [codex-steer-order](../../tests/replay/codex-steer-order.test.ts).

## Display wording

`@botiverse/oar/observe` supplies English text for OAR's own types. These
helpers are pure and import no Node modules or runtime adapters, so the
same wording works in a browser or JavaScriptCore:

| Helper | Input and result |
| --- | --- |
| `noticeText(notice)` | A `ViewNotice` to text, including its native reason and available retry details. Child turn outcomes are objects, read by their `kind`. |
| `noticeTone(notice)` | A `ViewNotice` to `quiet`, `warning` or `danger`. Completed work and a zero exit are quiet; retries, refusals, aborts and an unknown exit code warn; failed work and a nonzero exit are danger. |
| `phaseLabel(phase)` | A `RunningPhase` to a label such as `Waiting for model` or `Running <tool>`. |
| `failureText(failure, runtimeName, credential?)` | A `FailureClass` to a neutral sentence such as `Claude Code reported that its usage limit was reached.` With `auth`, a failed outcome's `credential` words it as a missing login (`Claude Code is not signed in.`) or a refused credential (`Claude Code's credentials were rejected.`); without it, `Claude Code could not authenticate.` The host adds any sign-in or recovery instructions. |
| `taskStatusLabel(status)` | A `TaskStatus` to its display label. |
| `toolGroupSummary(counts, state?)` | A tool group's English summary. With no calls, the reasoning-only group reads `Thought`, or `Thinking…` when `state` is `running`; `state` defaults to `done`. Tool counts retain their existing wording. |

The wording is for display and may change in any minor release. Hosts must
make decisions from the typed values, never parse these strings. For those
decisions, `failureAdvice(failure)` gives recovery timing per `FailureClass`:
`retry` is `now` (retry with ordinary backoff: `rate_limited`, `overloaded`,
`provider`, `runtime_exited`), `later` (wait for a limit to reset, typically
hours: `quota`) or `no`; `userAction` says a person has to act first (`auth`,
`billing`, `model_unavailable`, `input_too_large`). A `quota` failure's
`resetsAt`, where the runtime reports it (claude's subscription limits), is
when the limit resets; a time already past means unknown
([when a limit resets](runtime-matrix.md#when-a-limit-resets)). Continuing
then is the host's policy. A `RuntimeFailureError`
from `session()` carries the same `failure`.

This timing does not establish whether replaying an input or a whole turn
is safe. A `provider` or `runtime_exited` failure can follow tool execution
and file changes. The host decides whether to resend using
`ConversationInput.state`, a `dropped` input's `reason`, and records observed
after reopening. Even a `runtime_exited` drop means no echo was observed,
not proof the runtime never read the input; see [dropped input](#dropped-input).

The separate [`parseReport`](subagents.md#reading-results) helper reads only
`formatReport`'s own report format. Each union member is covered by tests
and exhaustive type checks in OAR, so an added member requires its wording
to be supplied here.
