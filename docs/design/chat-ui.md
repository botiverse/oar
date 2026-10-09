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
  runtime has not taken yet; a withdrawn one leaves it), `openTurn`, `status`, `model`, `effort`,
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
| `steer` / `queue` request | on a stream that has echoed an input id before (codex, claude): the input waits in `pendingInputs` until its echo. On one that never has (pi, cursor and the ACP runtimes): it enters `messages` at the request and seals the open segment |
| `prompt` / `steer` / `queue` response | updates the input in place, with attempts and delivery state (folded by `reduceConversation`). A rejected input enters `messages` there if it was waiting; a retry of it that must wait for its echo takes it back out |
| `withdraw` request / response | an attempt on the input it names. Accepted: the input is `withdrawn` and leaves `pendingInputs`, and `messages` too where the stream placed it at its request; the segment that request sealed stays sealed. Refused `not_queued`: nothing moves. Queued again, the input enters by the rows above |
| `text_delta`, `reasoning` | named text and readable reasoning rejoin their existing part of the same kind, lane and `messageId` anywhere in the current turn segment; sections retain first-appearance order. An input seal prevents joining across segments. Content without `messageId` keeps stream order and can still fragment across interleaved lanes; `redacted` and `empty` reasoning remain separate lifecycle-only parts ([grouping contract](../spec/conversation.md#session-view-message-grouping)) |
| `tool_call_started` / `input` / `progress` / `ended` | one tool part per lane and call id, settled where its start landed even after the turn ended; an end without a start still renders. `tool_call_input` replaces the part's `input` with the latest the runtime reported (arguments an ACP runtime sends after the start), leaving its state alone. `startedAt` / `endedAt` are the `receivedAt` of the start and end records (epoch ms): when OAR observed them, not a time the runtime reported, and only those it saw (a running call has no `endedAt`; an end without a start has no `startedAt`), as `tasksOf` does |
| `turn_ended` of the root agent in the root session | seals the turn segment and stamps its outcome; unresolved root tools in this turn become `ended`. A child agent's or session's end is a notice and never closes the root turn |
| `compaction_started` / `ended`, `retry` | notice parts inside the running turn |
| `app_request` / `app_answered` / `app_request_cancelled` | a `pendingRequests` entry and an actionable part carrying the native body, then settled: answered, or `cancelled` when the runtime withdrew it; the exit empties `pendingRequests`. `appRequestKind(type)` tells an approval, a question and a call the adapter serves itself apart (`unknown` otherwise); `appRequestText(type, body)` gives the words of the ask |
| `control_rejected` | a rejected prompt removes its empty turn; a rejected steer, queue or abort adds a notice, as does a refused withdraw of an input the view never held |
| root `exited` | `exited` set and a notice; the record fold closes the running turn as `aborted` after its accepted abort or dispose request, otherwise `failed: runtime_exited`. Flat events alone lack stop acceptance, so do not assign a turn outcome. Both paths mark this turn's unresolved root tools `ended`. Child exits are lane notices only |
| `user_message` | folds into the input's observations, never a second bubble. The first echo of a waiting steer or queue moves it from `pendingInputs` into `messages` there and seals the open segment: the input sits where the runtime took it, so replies to earlier input come before it. An unechoed input stays pending; neither a turn end nor text matching places it |
| `usage`, `model`, `effort` | the matching view fields |

When a root turn ends, its tools still marked `running` become `ended`,
including tools in earlier segments split by a mid-turn input. This means
their result is unknown: no result `content`, success/failure judgment, or
tool `endedAt` is inferred. Streamed output stays visible. A later native
`tool_call_ended` supplies the actual result and observation time in place;
late progress updates output without reopening the call. Child-agent tools,
child-session tools and background task state are unchanged.

## Mapping: the view to assistant-ui

For an application that renders with assistant-ui:

| View field | assistant-ui surface |
|---|---|
| input text, attempts, observations | user message text, plus metadata for a delivery badge |
| `pendingInputs` | outside the thread: a tray above the composer until the runtime takes the input. Where `session.withdraw` exists, a queued entry can offer withdraw, edit and send now (see Commands), and a withdrawn one leaves the tray. An entry the adapter already sent but the runtime has not echoed yet answers `not_queued`. On a stream that never echoes (pi, cursor, ACP runtimes) a queued input sits in `messages` instead, and the same commands can hang off that bubble while its latest attempt is a queue |
| text, reasoning | standard parts |
| tool part | tool call part (`argsText` from `input`, `result` from `content` once ended or the streamed `output` while running, `isError` when `result === "failed"`); image parts render as images |
| sub-agent section | a custom part and renderer: the projection's largest value, since every client otherwise rebuilds it |
| turn outcome | message status (`complete`, `incomplete`, error) |
| notices, `pendingRequests` | custom parts in flow, the latter actionable |
| `status` (plus a client-side stall check) | `isRunning` and the app's own chrome |
| `model`, `usage`, `context` | thread-level data outside the message list |

Edit, regenerate and branch of sent messages stay dark: OAR cannot rerun or
fork a runtime's history, and `ExternalStoreRuntime` enables those features
only when their callbacks exist. Input not yet sent is different: a queued
input still held by OAR can be withdrawn, edited or sent now (Commands).

## Commands

| UI action | Session call | Note |
|---|---|---|
| send | `deliver` | prompts when idle, steers or queues when running; where it landed is in the result and the stream, never assumed |
| steer now | `steer` | the control exists only when `session.steer` does (a kimi or antigravity session has none); the UI reads the member, never a runtime name |
| withdraw a queued input | `withdraw(inputId)` | the control exists only when `session.withdraw` does (not on codex). `accepted`: the input is the caller's again; `not_queued`: none is waiting (it already went to the runtime, or was withdrawn before) |
| edit a queued input | `withdraw`, then `queue` with the same `inputId` | only after an accepted withdraw; the input waits again from its new request |
| send a queued input now | `withdraw`, then `deliver` with the same `inputId` | only after an accepted withdraw; prompts when idle, steers into the running turn where the session can steer, otherwise queues it again |
| cancel | `abort` | acceptance says the stop was taken over; the outcome arrives at `turn_ended` or process exit |
| answer a runtime request | open, see below | |
| dispose | `dispose` | lifecycle, not a chat command |

## What this position refuses

- **No synthesized boundaries.** A turn opens on its prompt request or on the
  first event of an adopted turn (queued input, a mid-turn subscriber), the
  rule `reduceStatus` follows. Sub-agent sections come from observed lanes
  and message IDs, never an invented start event. A steer enters the transcript
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
