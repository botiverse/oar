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
| `now` (default) | `prompt`: a new turn, so an idle agent wakes | `steer`, or `queue` when the runtime cannot steer |
| `after_turn` | `prompt` | `queue`, or held until idle and then `prompt` when the runtime holds no queue |
| `when_idle` | `prompt` | waits until idle, then `prompt` |

A `prompt` refused `busy` (a turn opened between the status read and the
prompt) and a `steer` refused because the turn just ended (`no_active_turn`,
or the runtime's own refusal once the status shows that turn is over, as
codex answers a steer that reaches it after the turn) are retried as the new
state requires. `steerOrQueue` stays as the running half
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
resubmit an accepted input. OAR generates identity, not delivery evidence.

## Images

`InputOptions.images` hands image files (by absolute path) to the runtime with
the input, as its own image content: claude and ACP get base64 `image` blocks,
codex `localImage` paths, pi `ImageContent`. The request body records the
paths verbatim (`images: [{ path }]`), never the bytes, and
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
- `conversation`: Pi's user `message_start`. There is no proven native request
  association, so `inputId` is absent. Template expansion and duplicate text
  make text-based matching unsafe.

No evidence kind promises model consumption or semantic effect. Request
acceptance and native observation are independent facts. Grok and Kimi carry
logical input identity only; no native message correlation has been verified
for them. Raw payloads remain unmodified on frames. OAR never adds markers to
a user's input text to correlate it, and never derives a universal "consumed"
event from turn ends, text matching or native queue changes (pi's
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
`accepted`, `rejected`, or `untracked` (a native echo without an observed request).
An accepted attempt wins over later refusals; otherwise the latest attempt
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
all steering inputs from `turn_ended`. Cancellation is outside this contract.

Evidence: [local steer identity probes](../runtimes/steer-delivery.md). Regression
coverage includes pure reducer cases, mock fallback, and Codex/Claude native
harnesses with a local scripted provider.

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
  never has (grok and kimi echo nothing; pi's echo carries no `inputId`)
  places them at their request, the best fact it has. No capability flag
  or runtime name takes part.
- A rejected input enters where it was refused. If a retry of the same
  input (`deliver`, `steerOrQueue`) must wait for its echo, it leaves
  `messages` for `pendingInputs` again.
- An input never echoed stays pending, even after its turn ends: OAR does
  not invent a position for it from a turn end or matching text.

Records already folded in a stream (same `streamId`, `seq` not past the
cursor) leave the view unchanged, as they leave the conversation.

Evidence: a real codex run that steers three times while the agent sleeps,
replayed in [codex-steer-order](../../tests/replay/codex-steer-order.test.ts).
