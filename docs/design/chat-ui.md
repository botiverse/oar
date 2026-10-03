# Chat UI

OAR is application-agnostic, but chat-shaped clients (a transcript, a
composer, a status line) are the first consumer family with needs common
enough to deserve a projection of their own.

**The position: session state is the API; the UI is a stateless view over a
projection of it.** The projection belongs to OAR, not to each client.

## Why state, not message parts

The frontend chat ecosystem offers two integration shapes:

- **Message-part protocols** (the AI SDK's UI message stream and libraries
  built on it) flatten the world into user and assistant messages made of
  text, reasoning and tool parts. Attribution, input delivery, lifecycle and
  runtime requests survive only as extension payloads.
- **State protocols** (assistant-ui's `AssistantTransport`, or the transport-free
  `ExternalStoreRuntime`) stream a state snapshot to the client and take
  commands back; a pure converter renders it, and the UI owns nothing.

The second shape is OAR's own architecture read from the other side: records
are facts, views are folds, the consumer holds no truth of its own. It is also
the only shape in which OAR's reasons to exist stay visible: `agentPath`
attribution, delivery outcomes (steered, queued, rejected), runtime requests,
compaction and retry, resume across restarts. A snapshot is strictly more
expressive than a message stream, so a lossier message-part face can be
derived from it later if reach ever outranks fidelity.

## The surface

`@botiverse/oar/observe` ships the projection; it uses no Node API and no UI
framework:

- `SessionView`: `messages` (inputs and turn segments, each turn holding per
  lane sections and parts), `pendingInputs` (steered or queued inputs the
  runtime has not taken yet), `openTurn`, `status`, `model`, `effort`,
  `context`, `usage`, `usageByAgent`, `pendingRequests`, `exited`, and the
  underlying `conversation` fold.
- `reduceSessionView(view, record, streamId?)` folds one record;
  `viewOf(records)` replays a log; `initialSessionView()` starts one.

The framework binding (a React hook, an assistant-ui runtime) is the
application's, and is small: rowrow folds its timeline with
`reduceSessionView` and renders from the view. Everything above the binding
stays pure, replayable from a recorded log, and testable without a DOM.

## Mapping: events to the view

| Stream fact | View effect |
|---|---|
| `prompt` request | its `ConversationInput` enters `messages`, and its turn opens below it |
| `steer` / `queue` request | on a stream that has echoed an input id before (codex, claude): the input waits in `pendingInputs` until its echo. On one that never has (pi, grok, kimi): it enters `messages` at the request and seals the open segment |
| `prompt` / `steer` / `queue` response | updates the input in place, with attempts and delivery state (folded by `reduceConversation`). A rejected input enters `messages` there if it was waiting; a retry of it that must wait for its echo takes it back out |
| `text_delta`, `reasoning` | appended to the current section of the lane `(sessionId, agentPath)`; a `text_delta` whose `messageId` differs from the last text part's starts a new part (one per assistant message), one without a `messageId` joins the last; `redacted` and `empty` reasoning render as lifecycle-only parts |
| `tool_call_started` / `progress` / `ended` | one tool part per lane and call id, settled where its start landed even after the turn ended; an end without a start still renders |
| `turn_ended` of the root session | seals the turn segment and stamps its outcome; a child session's `turn_ended` is a notice and never closes the root turn |
| `compaction_started` / `ended`, `retry` | notice parts inside the running turn |
| `app_request` / `app_answered` | a `pendingRequests` entry and an actionable part, then settled |
| `control_rejected` | a rejected prompt removes its empty turn; a rejected steer, queue or abort adds a notice |
| `exited` | `exited` set, a notice, and the open turn sealed without a fabricated outcome |
| `user_message` | folds into the input's observations, never a second bubble. The first echo of a waiting steer or queue moves it from `pendingInputs` into `messages` there and seals the open segment: the input sits where the runtime took it, so replies to earlier input come before it. An unechoed input stays pending; neither a turn end nor text matching places it |
| `usage`, `model`, `effort` | the matching view fields |

## Mapping: the view to assistant-ui

For an application that renders with assistant-ui:

| View field | assistant-ui surface |
|---|---|
| input text, attempts, observations | user message text, plus metadata for a delivery badge |
| `pendingInputs` | outside the thread: a tray above the composer until the runtime takes the input |
| text, reasoning | standard parts |
| tool part | tool call part (`argsText` from `input`, `result` from `content` once ended or the streamed `output` while running, `isError` when `result === "failed"`); image parts render as images |
| sub-agent section | a custom part and renderer: the projection's largest value, since every client otherwise rebuilds it |
| turn outcome | message status (`complete`, `incomplete`, error) |
| notices, `pendingRequests` | custom parts in flow, the latter actionable |
| `status` (plus a client-side stall check) | `isRunning` and the app's own chrome |
| `model`, `usage`, `context` | thread-level data outside the message list |

Edit, regenerate and branch stay dark: OAR cannot rerun or fork a runtime's
history, and `ExternalStoreRuntime` enables those features only when their
callbacks exist.

## Commands

| UI action | Session call | Note |
|---|---|---|
| send | `deliver` | prompts when idle, steers or queues when running; where it landed is in the result and the stream, never assumed |
| cancel | `abort` | the outcome arrives as `turn_ended`, not as the call's return value |
| answer a runtime request | open, see below | |
| dispose | `dispose` | lifecycle, not a chat command |

## What this position refuses

- **No synthesized boundaries.** A turn opens on its prompt request or on the
  first event of an adopted turn (queued input, a mid-turn subscriber), the
  rule `reduceStatus` follows. Sub-agent sections are runs of observed
  `agentPath`, never an invented start event. A steer enters the transcript
  at the runtime's own echo, never at a position guessed from a turn end;
  whether a stream echoes is read off the stream, never off a runtime name.
- **No transport mandate.** View and commands are host-agnostic; in-process,
  IPC and HTTP are the application's choice.
- **No framework in the core.** Reducers are pure; bindings are leaves.
- **No UI-shaped persistence.** The view re-derives from records; stored
  `ViewMessage`s are a cache, never the store of truth.

## Open questions

1. **Answering runtime requests.** Adapters answer `toApp` requests
   automatically (full access by default) and `Session` has no
   `answer(requestId)`. A UI that wants human approval needs an opt-out of the
   automatic answer plus an answer call: the first session addition this
   direction forces.
2. **Long-lived streams over HTTP.** `AssistantTransport` assumes a command
   opens a run whose stream then closes, while OAR sessions stream
   continuously (queued input runs later, runtimes start turns on their own).
   In-process and IPC clients are unaffected; an HTTP shape waits on
   `oar serve` ([roadmap](roadmap.md) item 6).
3. **Display under weak attribution.** With the `opaque` or `none` tier the
   view shows one lane. That is correct by construction; richness degrades
   with the tier instead of being uniform.

## Evidence

The position was gated on a consumer whose renderer holds only display code;
rowrow now builds its timeline from `reduceSessionView`. Application-level
concepts layered on the same fold (rowrow's run boundaries, for example) stay
the application's: the projection makes room for them without owning them.
