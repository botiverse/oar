# Steer delivery and native identity

Scripted-provider probes, 2026-09-16; versions and reproduction:
[experiments/steer-delivery](../../experiments/steer-delivery/README.md). This
page keeps the runtime evidence: what each runtime echoes for a steer and how
the echo correlates with the input. The implemented API (`inputId`,
`user_message` evidence kinds, the conversation reducer) is specified in
[conversation.md](../spec/conversation.md). Cancellation is covered by
[input-cancellation.md](input-cancellation.md).

## What each runtime echoes

| Runtime | OAR steer and response | Native evidence after acknowledgement | Identity correlation |
|---|---|---|---|
| Codex 0.154.0 | `turn/steer`; `accepted`, `native: {turnId}` | `item/started` and `item/completed`, item type `userMessage`; the provider's next request contains the steer | `clientUserMessageId` round-trips as `item.clientId` (directly verified). OAR sends `inputId` as `clientUserMessageId` ([codex/session.ts](../../packages/oar/src/runtimes/codex/session.ts)) |
| Claude Code 2.1.273 | User message written to stdin; `accepted` without a native control response | Without replay, no steer echo, though the next provider request contains the steer. With `--replay-user-messages`, a native `user` frame echoes the input and its UUID | Supplying `uuid` and enabling replay was directly verified. OAR launches with `--replay-user-messages` and sends `inputId` as `uuid` ([claude/session.ts](../../packages/oar/src/runtimes/claude/session.ts)). Replay is an acknowledgement, not by itself proof of provider consumption |
| Pi SDK 0.84.2 | `AgentSession.steer()` queues the input; `accepted` | `queue_update`, then user `message_start` / `message_end`; the next provider request contains the steer | No request ID in the observed native user message. Timestamp and text are not a safe universal correlation key; the SDK expands templates/skills, so even text equality is not guaranteed |
| Grok 1.0.30 | From source: another `session/prompt` with `_meta: {sendNow: true}`, then `accepted` | Not wire-probed here; the native prompt result eventually appears as a frame. Natively a cancel and rerun ([grok](grok.md#prompting-steering-queuing-and-cancellation)) | OAR acceptance is not the ACP prompt's completion response. Native per-input consumption correlation is unverified |
| Kimi Code 0.42.0 | From source: no ACP steer method, so the session has no `steer`; `steerOrQueue` and `deliver` queue in the adapter-held queue | No native steer mapping on the selected ACP transport | Do not show queued input as successfully steered |
| Cursor `@cursor/sdk` 1.0.35 | `run.steer(text)`; `accepted` once the SDK answers `complete_delivered` (`native: {ack}`); `revert_to_followup` is rejected `runtime_refused` | A `user-message-appended` update with the text (live, real account, 2026-10-03); the steered text shaped the same turn's reply | Text only, no id. The acknowledgement itself waits for delivery, so the steer's `accepted` response is the correlation ([cursor](cursor.md#prompt-steering-queueing-and-abort)) |

The Codex, Claude and Pi probes ran real installed harnesses against a
**scripted local model endpoint**, not real accounts, each sending exactly one
unique input while a tool was running. They establish inclusion in that model
request for those runs, not universal timing, semantic influence, or race
safety. OAR projects these native observations as `user_message` events
([native observations](../spec/conversation.md#native-observations)).

## Native shapes

Codex (`{turnId}`) and Cursor (`{ack}`) carry `native` on the steer response;
Claude, Pi and Grok answer `{kind: "accepted"}` without it. OAR `request.id` / `response.requestId` are
operation identity, not native message identity.

Codex (JSON-RPC transport ID omitted):

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

Claude stdin and replay stdout (requires `--replay-user-messages`):

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

## Evidence strength

Each fact below is separate; none implies the next:

1. **Accepted / rejected:** acceptance ends the caller's delivery obligation;
   it is not evidence the model consumed the input.
2. **Native message observed:** a Claude replay acknowledgement and a Codex
   turn item differ in strength; neither means "model has read it".
3. **Provider inclusion:** verified only by these mock captures. Production
   transports generally do not expose the outgoing provider request as a
   stable per-input lifecycle event, so a UI cannot claim it.
4. **Semantic effect:** not a protocol state. Neither acceptance nor turn
   completion proves the model followed the instruction or an external effect
   happened.

Native messages without a proven request association stay unlinked; repeated
text is allowed, so never correlate by text alone.
