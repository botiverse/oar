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
| Grok 1.0.77 | `_x.ai/interject {sessionId, text, interjectionId: inputId}`; OAR accepts a successful RPC. Grok returned `{status: "queued"}` on the `_x.ai/interject` frame | `_x.ai/session/interjection` echoes text and `interjectionId` at once. The running turn takes it at its next safe point (after a tool batch, before a model call, before the turn returns): the next provider request contains it, and the original prompt answers once. One that misses the turn runs as Grok's own `interject-fallback-*` turn ([probe](../../experiments/grok-interject/README.md)) | The echo carries `interjectionId`; the drain itself has no live signal, so consumption is not reported |
| Devin CLI 3000.14.30821 | Another `session/prompt` on the active session; `accepted` after dispatch | Devin answers both prompt requests with the same final result (`stopReason`, usage and `cognition.ai/userMessageId`) and closes the turn once, on the last answer; the reply answered both requests' instructions | The control acceptance alone is not proof of provider consumption, and the duplicated answer carries no per-input correlation ([mapping](devin.md#steering)) |
| Antigravity CLI 1.5.0 | Another `session/prompt` on the active session; `accepted` after dispatch | The next provider request contains the steer inside the same tool loop. The original prompt answers early; only the newest prompt answer ends the OAR turn ([control](../../experiments/antigravity-cli-acp-2026-11-05.md)) | The control acceptance alone is not proof of provider consumption; no native per-input correlation is claimed |
| Kimi Code 0.42.0 (ACP fallback) | From source: no ACP steer method, so the session has no `steer`; `steerOrQueue` and `deliver` queue in the adapter-held queue | No native steer mapping on the selected ACP transport | Do not show queued input as successfully steered |
| Cursor `@cursor/sdk` 1.4.0 | `run.steer(text)`; `accepted` for `complete_delivered` or `{ outcome: "queued" }`, with `native.ack` naming that outcome; `revert_to_followup` is rejected `runtime_refused` | A `user-message-appended` update for local delivery (native 1.4.0, 2026-11-16); queued means the SDK owns a follow-up, whose cloud run OAR does not observe | Text only, no id. Delivered and queued transfer ownership; only delivered establishes same-turn delivery ([Cursor evidence](../../experiments/cursor-sdk-1.4/README.md)) |

Qwen and CodeBuddy sessions have no `steer` either, and neither do Devin and
OpenCode v2 sessions whose `initialize` does not advertise theirs
(`cognition.ai/midTurnPrompts` for Devin, `_session/steering` before 2.2.7 for
OpenCode v2) ([session controls](../spec/runtime-matrix.md#session-controls)).
The advertised OpenCode v2 steer was checked natively on 2.3.0 (Linux x64,
local provider, 2026-11-14): steers during a reply and during a running tool
reached the same turn's next model request; slash commands steer as plain
text; an aborted turn keeps an accepted steer for the next prompt
([OpenCode](opencode.md#v2-session-behavior)). 2.2.7 was not run natively.
DSH's `steer` (present only when its native method inventory advertises it)
and Factory's (a second `droid.add_user_message`, drained into the running
turn) were not probed here; see [DSH](dsh.md#oar-mapping) and
[Factory](factory.md#prompting-steering-queueing-and-abort). Kimi KAP builds
(`>= 2.7.2-botiverse.1` and confirmed `>= 2.7.3`) expose `steer` via
`POST /sessions/{id}/steer` (while ACP fallback keeps no `steer`), and
community runtime Cybion steers into the active Thread via
`POST /v1/threads/{id}/inputs`; see [Kimi](kimi.md#high-level-mapping-to-oar)
and [Cybion](cybion.md#high-level-mapping-to-oar).

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

OAR pairs the steer operation and its response using `request.id` and
`response.requestId`. Each runtime page documents any native receipt fields.

Grok's handler returns `queued` on its only success path. Invalid parameters
and a missing session produce RPC errors. The handler ignores the result of
sending the command to the session actor, so the reply alone cannot confirm
that the actor received the input. [Grok source](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/interject.rs#L27-L48).

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
