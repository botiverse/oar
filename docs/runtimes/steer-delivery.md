# Steer delivery and conversation reconstruction

Local source and scripted-provider investigation, 2026-09-16. Versions and
reproduction: [experiments/steer-delivery](../../experiments/steer-delivery/README.md).
This report records the pre-0.6 baseline and the proposal it motivated. The
implemented API and current mapping are specified in [conversation.md](../spec/conversation.md).
Cancellation remains deferred.

## What was observed

| Runtime | Current OAR steer response | Native evidence after acknowledgement | Identity / current gap |
|---|---|---|---|
| Codex 0.154.0 | `accepted`, `native: {turnId}` from `turn/steer` | `item/started` and `item/completed`, item type `userMessage`; provider's next request contains the steer | Native `clientUserMessageId` round-trips as `item.clientId` (directly verified). Current OAR does not supply it for steer, so the observed item has `clientId: null` |
| Claude Code 2.1.273 | `accepted` after writing stdin, without a native control response | Current adapter emits no steer echo; next provider request nevertheless contains the steer. With `--replay-user-messages`, a native `user` frame echoes the input and UUID | Supplying `uuid` and enabling replay was directly verified. Current OAR supplies neither. Replay is an acknowledgement, not by itself proof of provider consumption |
| Pi SDK 0.84.2 | `accepted` after `AgentSession.steer()` queues input | `queue_update`, then user `message_start` / `message_end`; next provider request contains the steer | No request ID in observed native user message; timestamp and text are not a safe universal correlation key. SDK expands templates/skills, so even text equality is not guaranteed |
| Grok 1.0.30 | Source: OAR sends another `session/prompt` with `_meta: {sendNow: true}`, then returns accepted | Not wire-probed here; native prompt result eventually appears as a frame | OAR acceptance is not the ACP prompt's completion response. Native per-input consumption correlation remains unverified |
| Kimi Code 0.42.0 | Source: OAR rejects steer as `not_steerable`; `steerOrQueue` can fall back to adapter-held queue | No native steer mapping on the selected ACP transport | Do not show queued input as successfully steered |

All three live probes used real installed harnesses with a **scripted local
model endpoint**, not real accounts. Each sent exactly one unique input while
a tool was running. These observations establish inclusion in that model
request for those runs, not universal timing, semantic influence, or race safety.

The native user-message facts above are retained in OAR `RawEvent` frames but
currently omitted from flat `events()`. Claude's echo additionally needs launch
and input changes before it exists in the stream at all.

## Actual shapes

OAR's records (envelope fields abbreviated, example IDs) are:

```ts
{ kind: "request", id: "r2", direction: "toRuntime",
  body: { kind: "steer", input: "change direction" },
  sessionId: "s", agentPath: [], seq: 12, receivedAt: 123 }
{ kind: "response", requestId: "r2",
  body: { kind: "accepted", native: { turnId: "t1" } },
  sessionId: "s", agentPath: [], seq: 13, receivedAt: 124 }
// A refusal instead has body: { kind: "rejected", reason: "..." }.
```

The `native` object in this example is Codex-specific. Claude/Pi currently
return `{kind: "accepted"}` without it. `request.id` and `response.requestId`
are OAR operation identity, not native message identity.

Native Codex (JSON-RPC transport ID omitted):

```ts
{ method: "turn/steer", params: {
  threadId: "s", expectedTurnId: "t1", clientUserMessageId: "input-1",
  input: [{ type: "text", text: "change direction" }]
} }
// RPC result: { turnId: "t1" }
// Later notification:
{ method: "item/started", params: { threadId: "s", turnId: "t1",
  item: { type: "userMessage", id: "native-message-1", clientId: "input-1",
    content: [{ type: "text", text: "change direction", text_elements: [] }] }
} }
```

Native Claude stdin and replay stdout (requires `--replay-user-messages`):

```ts
{ type: "user", uuid: "<client UUID>",
  message: { role: "user", content: [{ type: "text", text: "change direction" }] } }
// Later stdout:
{ type: "user", uuid: "<same client UUID>", isReplay: true, session_id: "s",
  message: { role: "user", content: [{ type: "text", text: "change direction" }] },
  parent_tool_use_id: null, timestamp: "..." }
```

Pi is an in-process SDK call, `await agentSession.steer(text)`, not a JSON RPC.
Observed native events include:

```ts
{ type: "queue_update", steering: ["change direction"], followUp: [] }
{ type: "message_start", message: { role: "user",
  content: [{ type: "text", text: "change direction" }], timestamp: 123 } }
```

## What Rao can truthfully restore

Keep separate facts rather than a single guessed “effective” status:

1. **Submitted:** request exists. Show the input immediately, before awaiting a
   result. With no response, acknowledgement is unknown, including after restart.
2. **Accepted / rejected:** match `response.requestId`. Acceptance ends the
   caller's delivery obligation; it is not evidence the model consumed the input.
3. **Native message observed:** correlate using native/client identity where
   available. Retain native message ID and turn ID. A Claude replay acknowledgement
   and a Codex turn item have different evidence strength; do not normalize both
   to “model has read it”.
4. **Provider inclusion:** independently verified by these mock captures. Most
   production transports do not expose the actual outgoing provider request as
   a stable per-input lifecycle event, so the UI generally cannot claim this.
5. **Semantic effect:** not a protocol state. Neither accepted nor turn-completed
   proves that a model followed the instruction or an external effect happened.

Persist the complete stream and derive the same view live and on replay. Keep
one logical input ID across steer rejection and queue fallback, but distinct
operation IDs for the attempts. A native echo updates the original bubble,
not a second message. Repeated text is allowed; never correlate by text alone.
Native messages without a proven request association remain unlinked facts.

Rao also needs its own append offset or stream-instance identity: OAR `seq` is
ordered within one retained stream, not a global identifier across fresh Session
instances after resume. Native message IDs can help deduplicate actual replay;
input content cannot. A turn end must not mark every pending steer consumed.

## Design that informed the conversation API

The following proposal was captured during the investigation; consult the
[shipped contract](../spec/conversation.md) for exported names and semantics:

- **One input identity across attempts.** Allow the host to supply an `inputId`
  for prompt/steer/queue; `steerOrQueue` preserves it across fallback. Operation
  request IDs remain distinct. This should be in records so replay does not
  depend on a caller's in-memory Promise or a Rao-only submission log.
- **Preserve native identity in adapters.** Codex: supply `clientUserMessageId`
  and read `item.clientId`; Claude: send a UUID and enable replay. Retain native
  message and turn IDs. Pi/Grok gaps remain explicitly unknown unless a safe
  native mechanism is established. Do not add markers to users' prompt text.
- **Normalize observed user messages as events.** Expose native echo/turn-item
  facts with optional `inputId`, `nativeMessageId`, `turnId`, and an explicit
  evidence kind. Do not create a universal `consumed` event from queue changes,
  text matching, or turn completion. Capability reporting can describe which
  identity/evidence each adapter supports.
- **A browser-safe conversation projection.** A pure reducer over `RawEvent`
  joins requests, responses, native user messages and assistant/tool events;
  a live observer wraps the same reducer. It groups fallback attempts and exposes
  pending/accepted/rejected plus native evidence. Rao persists records and renders
  this view rather than reproducing five protocols. Keep the existing flat
  events projection useful; do not rename a subscription and expect missing
  information to reappear.

Suggested sequence: input identity + Codex/Claude native echo mapping first,
then the reusable projection, then Rao's persistence/UI switch. Cancellation is
independent and remains deferred. The current Rao submission log fixes visibility
but is not yet this complete record-based design.
