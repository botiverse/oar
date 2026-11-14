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
| Qoder 1.1.78 | Stdin user message with `priority: next`; `accepted` after the write | At a tool boundary the next model request contains the steer within the current query; during a text-only response it starts a following query. Native local replay, Linux, 2026-10-24 ([evidence](../../experiments/qoder-native/README.md#input-priority-2026-10-24)) | `--replay-user-messages` echoes the submitted UUID as `user_message.inputId`. The control response and echo alone do not prove provider consumption |
| Codex 0.154.0 | `turn/steer`; `accepted`, `native: {turnId}` | `item/started` and `item/completed`, item type `userMessage`; the provider's next request contains the steer | `clientUserMessageId` round-trips as `item.clientId` (directly verified). OAR sends `inputId` as `clientUserMessageId` ([codex/session.ts](../../packages/oar/src/runtimes/codex/session.ts)) |
| Claude Code 2.1.273 | User message written to stdin; `accepted` without a native control response | Without replay, no steer echo, though the next provider request contains the steer. With `--replay-user-messages`, a native `user` frame echoes the input and its UUID | Supplying `uuid` and enabling replay was directly verified. OAR launches with `--replay-user-messages` and sends `inputId` as `uuid` ([claude/session.ts](../../packages/oar/src/runtimes/claude/session.ts)). Replay is an acknowledgement, not by itself proof of provider consumption |
| Pi SDK 0.84.2 | `AgentSession.steer()` queues the input; `accepted` | `queue_update`, then user `message_start` / `message_end`; the next provider request contains the steer | No request ID in the observed native user message. Timestamp and text are not a safe universal correlation key; the SDK expands templates/skills, so even text equality is not guaranteed |
| Grok 1.0.77 | `_x.ai/interject {sessionId, text, interjectionId: inputId}`; `accepted` once Grok answers `{result: {status: "queued"}}` (`native` on the frame `_x.ai/interject`) | `_x.ai/session/interjection` echoes text and `interjectionId` at once. The running turn takes it at its next safe point (after a tool batch, before a model call, before the turn returns): the next provider request contains it, and the original prompt answers once. One that misses the turn runs as Grok's own `interject-fallback-*` turn ([probe](../../experiments/grok-interject/README.md)) | The echo carries `interjectionId`; the drain itself has no live signal, so consumption is not reported |
| Antigravity CLI 1.5.0 | Another `session/prompt` on the active session; `accepted` after dispatch | The next provider request contains the steer inside the same tool loop. The original prompt answers early; only the newest prompt answer ends the OAR turn ([control](../../experiments/antigravity-cli-acp-2026-11-05.md)) | The control acceptance alone is not proof of provider consumption; no native per-input correlation is claimed |
| Kimi Code 0.42.0 | From source: no ACP steer method, so the session has no `steer`; `steerOrQueue` and `deliver` queue in the adapter-held queue | No native steer mapping on the selected ACP transport | Do not show queued input as successfully steered |
| Cursor `@cursor/sdk` 1.0.35 | `run.steer(text)`; `accepted` once the SDK answers `complete_delivered` (`native: {ack}`); `revert_to_followup` is rejected `runtime_refused` | A `user-message-appended` update with the text (live, real account, 2026-10-03); the steered text shaped the same turn's reply | Text only, no id. The acknowledgement itself waits for delivery, so the steer's `accepted` response is the correlation ([cursor](cursor.md#prompt-steering-queueing-and-abort)) |

Qwen and CodeBuddy sessions, and OpenCode v2 sessions whose `initialize`
does not advertise `_session/steering` (before 2.2.7), have no `steer`
either ([session controls](../spec/runtime-matrix.md#session-controls)).
The advertised OpenCode v2 steer was checked natively on 2.3.0 (Linux x64,
local provider, 2026-11-14): steers during a reply and during a running tool
reached the same turn's next model request; slash commands steer as plain
text; an aborted turn keeps an accepted steer for the next prompt
([OpenCode](opencode.md#v2-session-behavior)). 2.2.7 was not run natively.
DSH's `steer` (present only when its native method inventory advertises it)
was not probed here; see [DSH](dsh.md#oar-mapping).

The Codex, Claude and Pi probes ran real installed harnesses against a
**scripted local model endpoint**, not real accounts, each sending exactly one
unique input while a tool was running. They establish inclusion in that model
request for those runs, not universal timing, semantic influence, or race
safety. OAR projects these native observations as `user_message` events
([native observations](../spec/conversation.md#native-observations)).

In Claude 2.1.293 (compared with 2.1.292 on 2026-10-07), the `haiku`
alias selects Haiku 5.5, which carries the mid-turn input in a
`role: "system"` entry within the outgoing `messages` array. It still
arrives before that turn's end, and the replay UUID is unchanged. aimock's
normalized chat view drops that entry, so the vendor test inspects the
original request body; a normalized view alone is insufficient for this
model. The [comparison probe and report](../../experiments/runtime-version-checks/2026-10-07.md#claude-code-21293-evening-follow-up)
retain both views.

## Native shapes

Codex (`{turnId}`) and Cursor (`{ack}`) carry `native` on the steer response;
Claude, Pi, Grok and Antigravity answer `{kind: "accepted"}` without it. OAR `request.id` / `response.requestId` are
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
