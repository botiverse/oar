# Chat UI

OAR is application-agnostic: the record stream and the session contract
serve any host. Chat-shaped clients — a window, a transcript, a composer —
are the first consumer family with needs common enough to deserve a
projection of their own. This page records the position that projection
takes, and the boundary it must not cross.

**The position: session state is the API; the UI is a stateless view over a
projection of it.** The projection belongs to oar, not to each client.

## Why state, not message parts

The frontend chat ecosystem offers two integration shapes:

- **Message-part protocols** (the AI SDK's UI message stream and the
  libraries built on it): the world is flattened into user/assistant
  messages made of text, reasoning and tool-call parts. Everything a
  session is that is not a chat message — attribution, input delivery,
  lifecycle, runtime requests — survives only as an extension payload.
- **State protocols** (assistant-ui's `AssistantTransport` over HTTP, or
  its transport-free equivalent `ExternalStoreRuntime`): the backend
  streams an agent state snapshot and receives commands back; a pure
  `converter(state) → messages` function renders it. The UI owns nothing.

The second shape is oar's own architecture read from the other side:
records are facts, views are folds, the consumer holds no truth of its own.
It is also the only shape where oar's reasons to exist stay visible in the
UI: `agentPath` attribution, `steer`/`queue`/`rejected` delivery semantics,
runtime-initiated requests, compaction and retry, resume across restarts.
In a message-part protocol all of those are second-class; in a state
protocol they are fields.

Choosing state-first does not refuse the message-part world. A snapshot is
strictly more expressive than a message stream, so a
`SessionView → UIMessageChunk` projection can be added later as a second,
lossier face if ecosystem reach ever outranks fidelity.

## The surface

Three pure layers plus one thin binding:

```ts
// @botiverse/oar/observe — no Node, no React
interface SessionView {
  readonly messages: readonly ViewMessage[];      // grouped projection
  readonly status: AgentStatus;                   // reduceStatus
  readonly model: string | null;
  readonly usage: SessionUsage;
  readonly context: ContextUsage | null;
  readonly live: boolean;                         // stream attached / exited
  readonly pendingRequests: readonly AppRequest[]; // toApp requests awaiting answer
}

function reduceSessionView(state: SessionView, record: RawEvent): SessionView;
function viewOf(records: readonly RawEvent[]): SessionView;   // replay

// @botiverse/oar/ui (framework-free)
function toThreadMessages(view: SessionView): readonly ThreadMessageLike[];

// @botiverse/oar/react (or the app's own 50 lines)
function useOarRuntime(source: SessionSource): AssistantRuntime;
```

`SessionSource` abstracts where the session lives — an in-process
`Session`, an IPC channel, or an HTTP endpoint. The binding is the only
framework-aware layer; everything above it stays pure, replayable from a
recorded log, and testable without a DOM — the same discipline
`reduceConversation` already keeps.

## Mapping: events → view

| Stream fact | View effect |
|---|---|
| `prompt`/`steer`/`queue` request + response | `ConversationInput` in place (attempts, accepted/rejected, observations) — the user bubble and its delivery state, already folded by `reduceConversation` |
| `text_delta` | append to the current assistant section's text part (lane = `(sessionId, agentPath)`; coalescing is a display option) |
| `reasoning` | reasoning part, same coalescing rule; `redacted`/`empty` render as lifecycle-only parts |
| `tool_call_started` / `progress` / `ended` | one tool part per `(agentPath, callId)`; running → settled `{output, result}`; an end without a start is still a fact and renders as such |
| `turn_ended` | closes the assistant message and stamps `outcome` on it |
| `compaction_started`/`ended`, `retry`, `warning` | notice parts inside the running turn (they carry `seq`/`agentPath`, they are not system chrome) |
| `app_request` | `pendingRequests` entry + an actionable part in flow |
| `app_answered` | settles the pending entry |
| `control_rejected` | the owning input's delivery state changes; no separate notice unless the input is unknown |
| `exited` | `live: false` + a notice |
| `user_message` | folds into `ConversationInput.observations`; never a second bubble |
| `usage`, `model` | `usage`/`context`/`model` fields |

## Mapping: view → assistant-ui

| View field | assistant-ui surface |
|---|---|
| input text | user message, text part |
| input attempts/observations | message metadata → delivery badge (custom user-message renderer) |
| text / reasoning | standard text / reasoning parts |
| tool part | tool-call part (`argsText` ← `input`, `result` ← `output`, `isError` ← `result === "failed"`) |
| sub-agent section (a contiguous run of deeper-`agentPath` events) | custom part + custom renderer — the projection's largest value; today every client hand-rolls this |
| turn outcome | assistant message status (`complete` / `incomplete` / error) |
| notices | custom part in flow |
| `pendingRequests` | custom part rendered actionable; answering sends a custom command |
| `status` (+ client-side `stallOf`) | `isRunning` + the app's own chrome (phase label, stuck indicator) |
| `model`/`usage`/`context` | thread-level data, rendered in composer/header outside the message list |

Edit, regenerate and branch stay **dark**: oar cannot re-run or fork a
runtime's history, and `ExternalStoreRuntime` lights features up only when
their callbacks exist. That is the honest behavior, not a limitation to
paper over.

## Commands

| UI action | Session call | Note |
|---|---|---|
| send while idle | `prompt` | one "send" semantic; the session reports where input landed |
| send while running | `steerOrQueue` | landing (`steered`/`queued`/`rejected`) is read back from the stream, never assumed |
| cancel | `abort` | outcome arrives as `turn_ended`, not as the call's return value |
| answer a runtime request | **gap — see below** | `add-tool-result` or a custom `answer` command |
| dispose | `dispose` | lifecycle, not a chat command |

## What this position refuses

- **No synthesized boundaries.** A turn opens on its prompt request or on
  the first event of an adopted turn (queued input, mid-turn subscriber) —
  the same rule `reduceStatus` already follows. Sub-agent sections are
  contiguous runs of observed `agentPath`, never an invented
  `subagent_started` a runtime did not emit.
- **No transport mandate.** View and commands are host-agnostic;
  IPC/HTTP/in-process are `SessionSource` details. `useOarRuntime` is not
  allowed to assume a wire exists.
- **No React in the core.** The reducer and converter are pure;
  framework bindings are leaves.
- **No UI-shaped persistence.** The view re-derives from records; a log of
  `ViewMessage`s is a cache, never the store of truth.

## Open questions

1. **Command-scoped runs vs. a session that never ends.**
   `AssistantTransport` assumes a command opens a run and its stream
   closes; oar sessions stream continuously (queued input consumed later,
   spontaneous notices). The Electron/IPC path is unaffected — it uses
   `ExternalStoreRuntime` directly. The HTTP path needs a spike: whether
   `useAssistantTransportRuntime` (`resumeApi`) tolerates a persistent
   state channel, or the serve shape is a plain SSE view stream plus a
   command endpoint.
2. **Answering runtime requests.** Today adapters auto-answer `toApp`
   requests (YOLO default) and `Session` exposes no `answer(requestId)`.
   A UI that wants human approval needs an opt-out of the automatic
   answer plus an answer call — the first session-surface addition this
   direction forces.
3. **Grouping under weak attribution.** With `opaque`/`none` tiers the
   view shows one lane; correct by construction, but the doc-worthy point
   is that display richness degrades with the tier instead of being
   uniform.
4. **Non-text input.** `prompt`/`steer`/`queue` take `input: string`;
   file/image parts have no home. A chat client that wants attachments
   forces an input-model question, not a UI question.
5. **Where the fold runs.** Renderer folds events (replayable, proven by
   rao) vs. the host pushing view deltas. Both fit; records remain the
   portable artifact either way.

## Evidence

This position is gated on a consumer spike the same way every other entry
in [roadmap.md](roadmap.md) is: build one chat client whose renderer
contains only display code — the rao rewrite is that spike — and let what
the adapter still cannot express correct this page. What stays
application-level is itself data: rao's `runtime_handoff` marker is a
client concept layered on the same fold, and the projection must make
room for such extensions without owning them.
