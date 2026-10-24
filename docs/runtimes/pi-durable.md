# Pi Durable

Pi Durable runs an agent over a host-owned `Harness`, storage, model catalog,
extension registry and execution environment. OAR uses
`@earendil-works/pi-durable` **1.4.0**, including its experimental
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

The host passes the **same `Models` instance or `() => Models` supplier** it
supplied to `Harness.open`. A supplier lets the host replace its catalog
without recreating either the Harness or OAR runtime. Harness exposes no
public catalog getter, so OAR cannot verify this identity.
The host installs `@earendil-works/pi-durable@~1.4.0` and
`@earendil-works/chord@~1.4.0`, both optional peers of OAR. OAR operates on
the host's native package instances, without bundling another copy. Tests
pin 1.4.0; upgrading this experimental API requires rerunning the native
probe and vendor tests below.

**Upgrading from 1.3.0:** the host must upgrade both peers. The native
[Durable 1.4.0 changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/CHANGELOG.md)
specifies an automatic SQLite schema migration to version 2 on open; the
migrated database cannot be opened by 1.3.0 or earlier. JSONL needs no schema
migration, but older versions cannot resume the new sleeping tasks. Host
extensions must also follow the native task/document API changes, including
the replacement of `TaskRuntime.sleep()` and required `checkpointWhen`.
Custom Chord contexts now require `telemetry`; see its
[changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/chord/CHANGELOG.md).
OAR's event mapping needed no code change. The checks below cover native JSONL
reopen and browser MemoryStorage, not SQLite migration or host extensions.

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

Resuming a valid native conversation id that `Harness.conversation()` reports
as absent throws `SessionNotFoundError`. The lookup belongs to the supplied
Harness and its storage; OAR never creates a replacement conversation. The
cause records the lookup method, numeric id and native `undefined` result.
Malformed ids are rejected before lookup, and storage failures retain their
original error rather than being classified as missing.

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
session_closed, session_failed, retired or listener_error), its native
WatchEnd is retained in a frame, followed by an `exited` response with code
null. This ends the observed turn and makes later control return
`runtime_exited`; it does not claim that shared Harness execution stopped.
Since 1.2.0 a storage failure closes the native session and ends its watch
with `session_failed`; recovery requires reopening the host Harness from
storage. A failed submission query during snapshot recovery is an error
frame, preserving observation without guessing a turn outcome. API, storage
and watch-listener errors retain JSON-safe `name`, `message` and a scalar
`code` when present, without Error objects or cause chains, so the summary
survives JSON persistence even when the original error has a cyclic cause.

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

### Liveness and parked tasks

A running OAR status is evidence of an unfinished native run, not a guarantee
that its tasks can make progress. In 1.4.0, the default `restartLimit` parks
a task after five consecutive interruptions without task-state progress
(crash, eviction or reset; a normal Harness close does not count). The host
receives `onReport` with `type: "task_parked"`; `Harness.inspect()` shows the
task as `blocked` with reason `restart_limit`.

Parking does not end the run or close its `watchEvents` stream. The snapshot
still contains the run, so OAR continues to report running and emits no
invented `turn_ended`. Hosts must use their native `onReport` or `inspect()`
to distinguish this condition from work that can progress. Reopening an OAR
Session enables scheduling but does not unpark the task. Recovery is a host
decision: native `Harness.retryTask(taskId, context)` clears the restart
count and schedules it again. The [parking probe](../../experiments/pi-durable-parked-task.ts)
verifies this with five actual process deaths, then one explicit retry.

## Options, models and instructions

`model` is `provider/model`, resolved against the supplied catalog. `effort`
is a supported native thinking level; OAR validates it against that model's
menu. Both are applied and read back before returning. `listModels` reads
`Models.getModels()`, including entries whose credentials may be unavailable;
it does not authenticate or turn an empty catalog into `unauthenticated`.
OAR installs no providers or keys. The host owns those decisions.

When `models` is a supplier, OAR calls it for every `listModels` query and
every session open, including resume. Model selection and effort validation
use that open's current catalog, including the saved model when resume
specifies only `effort`. A removed model is refused when explicitly selected;
replacing a catalog does not itself rewrite saved conversation settings.

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
there is no verified per-conversation OAR channel for these options. `name`
is refused because Pi Durable exposes no session name. Local-file image
input is refused whole (`capabilities.images: false`).

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
| `tool_execution_end` | model calls read content and ok/failed from the native tool-result entry; nested calls read ok/failed from native `result.isError` and a reported numeric `result.structuredOutput.exitCode`, without inventing content; no result means just ended |
| `agent_changed` / snapshot agent | model and effort actually stored |
| `usage_changed` / snapshot usage | conversation's own model and tool token ledgers minus the totals at attachment |
| `auto_retry_start` | retry with native attempt and reason |
| blocking `compaction_start` | compaction started; end receipts, including 1.2.0 error text, stay raw |

Since 1.2.0, native tool implementations return model content in
`ToolExecutionResult.output`; the model-facing transcript still uses a
tool-result message with `content`, which OAR reads. Nested calls have their
own call ids and result summaries, and running nested calls are adopted from
`snapshot.nestedTools`; parent task ids and the rest of structured tool output
stay raw. CodingTools' structured exit is available only on nested calls in
1.2.0 through 1.4.0. Model-issued calls omit it from `watchEvents`, even when the diagnostic
text mentions an exit code, so OAR leaves `exitCode` absent for those calls.
The local execution environment reports SIGTERM as 143, not null; OAR preserves
the native value. The [native exit-code test](../../sea-trial/vendor/pi-durable-exit-code.vendor.test.ts)
covers both paths, a non-command tool and JSON storage.

The optional `reasoning` counter in each model or tool usage entry is part
of its output. OAR sums the reported parts and subtracts the attachment
snapshot's reasoning total, just as it does for input, output and caches.
Missing counters stay absent; repeated cumulative ledger reports do not
add the same spend again. This uses Pi Durable 1.2.0's native `UsageState`
and pi-ai `Usage`, verified by projection tests.

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

Native source: [v1.2.0 README](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/README.md),
[JSON example](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/test/examples/19-json.ts)
and [events](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/src/harness/events.ts),
checked against installed 1.2.0 on 2026-10-13
([report](../../experiments/runtime-version-checks/2026-10-13.md#pi-durable-and-chord-120)).
On 1.3.0 (2026-10-16) the 23 native tests, including the exit-code test, and
the shared behavior suite (18 passed, 1 skipped) pass
([report](../../experiments/runtime-version-checks/2026-10-16.md)). The
[probe](../../experiments/pi-durable-probe.ts) prints actual batches and
checks persisted instructions and request deduplication after JSONL reopen.
On 1.4.0 (2026-10-22), all 23 native tests, 18 shared behavior cases (one
skipped), that probe and the Chromium demo smoke test pass
([report](../../experiments/runtime-version-checks/2026-10-22.md)).

The [1.4.0 parking probe and findings](../../experiments/pi-durable-parked-task.md)
(2026-10-23) cover the default restart limit with JSONL storage: the host sees
`task_parked` while OAR sees an unfinished run, and explicit host retry lets
that same run finish. Option tests replace the native model catalog after
runtime construction and check listing, new and resumed model validation,
and effort validation for a saved model.

`OAR_TEST=pi-durable-aimock pnpm sea-trial` runs the public contract against
the real SDK with a local scripted provider.
`OAR_TEST=pi-durable-aimock pnpm vitest run sea-trial/vendor/pi-durable*.test.ts`
covers steering at a tool boundary, follow-ups, withdrawal, native abort,
provider errors, active adoption, disposal, JSONL recovery, request
deduplication, native backlog overflow, storage failure closure, nested tool
results and adoption, and command exit codes. Pure projection, option and
browser-bundle checks live under `tests/pi-durable`, `tests/turn-active.test.ts` and
`tests/browser-entry.test.ts`. These checks need no login or model quota;
they do not establish behavior of an arbitrary host extension or provider.

The [browser demo](../../apps/pi-durable/README.md) runs a host-owned Harness
with MemoryStorage and the native Anthropic fetch provider. Its Chromium
smoke test covers conversation rendering, abort and cleanup against local
scripted HTTP responses, with no real credentials. Run
`pnpm durable-demo:smoke` after installing Playwright's Chromium.

## Additional directories

A non-empty `SessionOptions.additionalDirectories` is declared refused
before creating or changing a conversation. Version 1.2.0 exposes one agent
cwd; the host owns the Harness filesystem environment. There is no verified
per-conversation multi-root directory option.

[Evidence and verification limits](../../experiments/additional-directories-2026-10-11.md).

## Structured output

`SessionOptions.outputSchema` is declared refused before creating or watching
a conversation. The native Harness exposes no final-answer schema option.
Tool parameter schemas are unrelated; OAR does not rewrite conversation
instructions to imitate native validation.

[Native channel audit](../../experiments/structured-output-2026-10-11.md).

## User configuration

`userConfiguration: "exclude"` is declared refused with
`UnsupportedOptionError` before opening a session. This adapter has no
verified separation of user configuration from native login and session
history. Omission and `"include"` retain existing behavior. See the
[shared contract](../spec/runtime-matrix.md#user-configuration).
