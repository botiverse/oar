# Pi Durable

Pi Durable runs an agent over a host-owned `Harness`, storage, model catalog,
extension registry and execution environment. OAR uses
`@earendil-works/pi-durable` **1.1.0**, including its experimental
`watchEvents` interface. This is a separate runtime from the Pi coding-agent
SDK: it does not load a Pi CLI login, settings directory or session file.

## Native objects and calling interface

A Harness is an open scheduler and storage connection. A conversation is a
persisted sequence of entries plus agent configuration, submissions and tasks.
Its numeric id is meaningful only in that storage. A submission has a durable
receipt (`queued`, `placed`, `done` or `unanswered`), and an optional
conversation-scoped `requestId` for deduplication. A run owns one or more
submissions and can contain multiple model turns and tool rounds.

`Harness.createConversation` creates an ownerless conversation;
`Harness.conversation(id)` reopens one. `conversation.submit` returns a
submission handle, not an answer. `submission.status`/`wait` read its receipt.
`watchEvents` attaches atomically with an initial snapshot and then delivers
ordered arrays of agent events, one per commit. A slow listener can receive a
replacement snapshot instead of the intervening batches.

The host passes the **same `Models` instance** it supplied to `Harness.open`:
Harness exposes no public catalog getter, so OAR cannot verify this identity.
The host installs `@earendil-works/pi-durable@~1.1.0` and
`@earendil-works/chord@~1.1.0`, both optional peers of OAR. OAR operates on
the host's native package instances, without bundling another copy. Tests
pin 1.1.0; upgrading this experimental API requires rerunning the native
probe and vendor tests below.

```ts
import { createPiDurableRuntime } from "@botiverse/oar/pi-durable";

// harness and models were opened/configured by the host with the native SDK.
const runtime = createPiDurableRuntime({ harness, models });
const session = await runtime.session({ kind: "available", via: "bundled" }, {
  cwd: "/workspace", model: "provider/model", appendSystemPrompt: "Check your work.",
});
const inputId = crypto.randomUUID();
await session.prompt("Inspect the project", { inputId });
// Keep session.id with the identity of the host's storage for later resume.
```

The constructor is exported only by `@botiverse/oar/pi-durable`, usable in
Node and browsers. The root and portable `@botiverse/oar/browser` core do not
import this adapter and load without its optional peers. It is absent from `defaultRuntimes` and the
CLI: the host must supply its Harness. `installation()` reports bundled and
available without probing a binary or credentials. Login, account quota,
updates and inventories are not implemented by this adapter.

## Controls and ownership

| OAR operation | Native operation | Meaning |
|---|---|---|
| `session({ resume })` | conversation lookup, configure, `watchEvents`, `Harness.resume()` | Attaches to saved work and enables scheduling of unfinished tasks; no new input is submitted |
| `prompt` | `submit({ whenBusy: "reject" })` | Fresh input while locally running is refused busy; an unseen native run is runtime_refused |
| `steer` | `submit({ whenBusy: "steer" })` | Joins an active run at its next input boundary; idle requests are refused |
| `queue` | `submit({ whenBusy: "followUp" })` | Durable follow-up input; `capabilities.queue.durable` is true |
| `withdraw(inputId)` | lookup by request id, `submission.abort()` | Accepted only while native cancellation says `aborted`; already placed/settled or missing is `not_queued` |
| `abort` | `conversation.abort()` | Stops the native run and its pending inputs; outcome comes from native submission receipts |
| `dispose` | `watch.stop()` | Detaches this controller, preserving the conversation, running work, storage and Harness |

Dispose is idempotent and records an accepted response. It emits no process
exit and does not infer a turn outcome. To stop work, call `abort` before
`dispose`. The host closes its Harness when appropriate. Closing a Harness
stops its invocations but leaves durable work recoverable; opening an OAR
Session resumes that scheduler. Recovery may repeat an interrupted provider
request or a replayable tool, so submission deduplication is not a promise of
exactly-once external side effects. Extension replay policy remains native.

If the watch ends without this controller disposing it (stopped, cancelled,
session_closed, retired or listener_error), its native WatchEnd is retained
in a frame, followed by an `exited` response with code null. This ends the
observed turn and makes later control return `runtime_exited`; it does not
claim that shared Harness execution stopped. A failed submission query during
snapshot recovery is an error frame, preserving observation without guessing
a turn outcome. API and watch-listener errors retain JSON-safe `name`,
`message` and a scalar `code` when present, without Error objects or cause chains.

Fresh prompts use the session status immediately before their request: running
means local `busy`, without submitting; idle never returns `busy`. If another
controller started work before the watch caught up, native `ConversationBusy`
is `runtime_refused` with the native message. A previously submitted inputId
is instead accepted as a retry, even while running, without new submission.

An open or resumed snapshot with a run emits `turn_active`, making status
running before any model output. It creates a view turn only if none is
already open. A native `run_start` after an OAR prompt therefore does not
create a second turn. The adapter does not invent a prompt or span id for
adopted work. Session ids are native conversation ids serialized as decimal
strings, not globally unique identifiers.

`InputOptions.inputId` becomes native `requestId` for all input controls.
Retry with the same id queries/reuses the existing submission even if the
supplied text differs. For a completed prompt retry while idle, a query frame
carries its terminal receipt and projects `turn_ended`: the request still
produces `turn_started`, but no old message content is replayed. The content
is in the original records or native history. A queued/placed receipt does
not imply completion. A completed retry never ends a different active run.

## Options, models and instructions

`model` is `provider/model`, resolved against the supplied catalog. `effort`
is a supported native thinking level; OAR validates it against that model's
menu. Both are applied and read back before returning. `listModels` reads
`Models.getModels()`, including entries whose credentials may be unavailable;
it does not authenticate or turn an empty catalog into `unauthenticated`.
OAR installs no providers or keys. The host owns those decisions.

`cwd` sets the conversation's native agent cwd, which the host's environment
factory can use. It does not grant access to a local filesystem in a browser.
`appendSystemPrompt` maps to native `instructions`, appended after extension
prompt sections. Saved instructions survive reopen: omitting the option
retains them; supplying it replaces the saved instructions value, without
concatenating it again. `systemPrompt` replacement is refused.

Resume configuration is transactional. While adopting an active run, supplied
cwd/model/effort/instructions must match its saved settings; changed values
are refused before mutation. Reopen after the run finishes to change them.
The runtime also refuses `env`, `launchArgs`, `serviceTier`, `mcpServers` and
`disallowedTools`. Environment and extensions belong to the host Harness;
there is no verified per-conversation OAR channel for these options.
Local-file image input is refused whole (`capabilities.images: false`).

## Records, snapshots and limits

Every native batch is one `pi-durable/events` frame, with its array unchanged
as `native`. Unknown events and events without an OAR projection remain there.
The initial snapshot is its own `snapshot` frame. Stream closure is a native
`pi-durable/watch_closed` frame; it is not evidence of a process exit.

| Native fact | OAR reading |
|---|---|
| snapshot with run / `run_start` | `turn_active` |
| `run_end` and its terminal submission receipts | `turn_ended`: done → completed; unanswered/aborted → aborted; other unanswered → failed |
| assistant `message_start`, `message_update`, `message_end` | text and reasoning suffixes, without duplicating full blocks already streamed |
| user `message_end` | `user_message`, native entry id, and inputId where a submission names that entry |
| `tool_execution_start` | tool name, call id and arguments |
| `tool_execution_update` | whole retained output window reconstructed from native trim/append or replacement; diagnostic/details fields stay raw |
| `tool_execution_end` | result content and ok/failed only when its native entry has a tool result; otherwise just ended |
| `agent_changed` / snapshot agent | model and effort actually stored |
| `usage_changed` / snapshot usage | conversation's own model and tool token ledgers minus the totals at attachment |
| `auto_retry_start` | retry with native attempt and reason |
| blocking `compaction_start` | compaction started; end has no verified outcome and stays raw |

Native model `turn_start`/`turn_end` are internal rounds, not OAR turns.
`run_end` precedes the terminal submission event in the same native batch;
the fold reads all receipts in the batch before deciding the outcome.

A snapshot keeps all native entries and current state, but completed history
is **not** replayed as newly observed text or events. OAR projects current
partial output and running tool state. On backlog overflow it preserves the
replacement snapshot, without fabricating missed batches. If a previously
observed run disappeared, OAR queries its actual submission receipts in a
separate `pi-durable/submissions` frame before reporting a terminal outcome.
A native text replacement that is not an extension of the observed text
stays raw, since OAR has no text-replacement event.

The chosen watch covers one conversation. Pi Durable can create child
conversations, but this watch does not include their events; attribution is
`opaque`, with no inferred child graph or child usage. Context occupancy,
background task projection, native history navigation and child subscriptions
are not exposed. Host applications persist their OAR records to render a
continuous transcript across controllers; native storage and OAR records
remain distinct artifacts.

## Evidence and verification

Native source: [v1.1.0 README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md),
[JSON example](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/test/examples/19-json.ts)
and [events](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/harness/events.ts).
Reviewed at `abe508e` on 2026-10-09. The
[probe](../../experiments/pi-durable-probe.ts) prints actual batches and
checks persisted instructions and request deduplication after JSONL reopen.

`OAR_TEST=pi-durable-aimock pnpm sea-trial` runs the public contract against
the real SDK with a local scripted provider.
`OAR_TEST=pi-durable-aimock pnpm vitest run sea-trial/vendor/pi-durable*.test.ts`
covers steering at a tool boundary, follow-ups, withdrawal, native abort,
provider errors, active adoption, disposal, JSONL recovery, request deduplication
and native backlog overflow. Pure projection, option and browser-bundle checks
live under `tests/pi-durable`, `tests/turn-active.test.ts` and
`tests/browser-entry.test.ts`. These checks need no login or model quota;
they do not establish behavior of an arbitrary host extension or provider.
