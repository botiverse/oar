# Inputs and conversation projection

An input is a logical user submission; a request is one delivery attempt.
`prompt`, `steer`, `queue`, and `steerOrQueue` accept an optional
`{ inputId }` UUID. Built-in sessions generate one when absent and record it on
input request bodies. `steerOrQueue` preserves it across steer rejection and
queue fallback; each attempt has its own request ID. Custom adapters must copy
`InputOptions.inputId` into the request body. Older records without an input ID
remain readable, but their separate attempts cannot be merged reliably.

UUIDs are required because Claude's native input identity uses UUIDs. A supplied
ID must represent exactly one logical input, including retries of that input;
reusing it for a different input merges those submissions by design. Do not
resubmit an accepted input. OAR generates identity, not delivery evidence.

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
acceptance and native observation are independent facts. Grok and Kimi gain
logical input identity, without claiming a native message correlation that
has not been verified. Raw payloads remain unmodified on frames.

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
raw records, not maps or Promise results, to reproduce the view after restart.
Application-owned persistence also supports search, indexes, and product data;
it is not merely a workaround for missing native replay. See the
[application data ownership boundary](../design/foundations.md#replay-boundary).

Rao uses this reducer over its persisted records. It shows input requests
immediately and hides routine success badges. It must not infer completion of
all steering inputs from `turn_ended`. Cancellation is outside this contract.

Evidence: [local steer identity probes](../runtimes/steer-delivery.md). Regression
coverage includes pure reducer cases, mock fallback, and Codex/Claude native
harnesses with a local scripted provider.
