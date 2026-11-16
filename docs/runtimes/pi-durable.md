# Pi Durable

Pi Durable runs an agent over a host-owned `Harness`, storage, model catalog,
extension registry and execution environment. OAR uses
`@earendil-works/pi-durable` **1.5.2**, using its synchronous
`Harness.observeConversation` interface. This is a separate runtime from the Pi coding-agent
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
`Harness.observeConversation` attaches atomically with an initial
`ConversationView` and then delivers every native change as a `WatchCall`: the
next value, delta operations and retirement flag. Unlike the asynchronous
`Conversation.watch()` listener, this synchronous observer does not coalesce
changes while a consumer is busy. OAR only queues notifications on the native
publication line; projection, record listeners and submission queries run
after that callback returns. Callbacks received before attachment resolves
are buffered behind the initial snapshot.

The host passes the **same `Models` instance or `() => Models` supplier** it
supplied to `Harness.open`. A supplier lets the host replace its catalog
without recreating either the Harness or OAR runtime. Harness exposes no
public catalog getter, so OAR cannot verify this identity. Build this catalog
with the Pi AI version matching the host Harness, currently 1.5.2, through a
version alias, keeping Pi AI 1.5.0 under its normal name for the bundled
coding SDK:

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "1.5.0",
    "@earendil-works/pi-ai-durable": "npm:@earendil-works/pi-ai@1.5.2",
    "@earendil-works/pi-durable": "1.5.2",
    "@earendil-works/chord": "1.5.2"
  }
}
```

Use `import { createModels } from "@earendil-works/pi-ai-durable/models"`
and the same alias for Durable provider imports. Tool parameter schemas are
JSON Schema objects; Pi AI 1.5.2 no longer supplies the old `Type` export. Pinning the normal
`@earendil-works/pi-ai` name to another version instead can split the coding SDK's 1.5.0
registration instances, and a single-file host then fails OAuth derivation
with `Cannot find module` for the provider module. The factory takes its
catalog type from the Durable peer, independently of OAR's bundled Pi coding
SDK 1.5.0.
The host installs `@earendil-works/pi-durable@~1.5.2` and
`@earendil-works/chord@~1.5.2`, both optional peers of OAR. Resolve both to
exactly the same native version; mismatched copies can split native identities.
OAR operates on
the host's native package instances, without bundling another copy. Tests pin
1.5.2; this migration leaves the bundled Pi coding SDK and its Pi AI on 1.5.0.
The [migration report](../../experiments/pi-durable-native-watch/README.md)
records the native API, persistence and observation controls.

**Upgrading from 1.4.0:** back up host storage before using the new Harness.
Pi Durable 1.5 writes `pi.live` document version 3, which 1.4 cannot read. A
read-only reopen need not rewrite that document; the JSONL control first
became unreadable by 1.4 after new work was committed under 1.5.2. Restore the
backup to roll back, rather than reopening migrated data with 1.4. OAR does
not copy, migrate or restore host storage itself.

Hosts with custom storage drivers must implement the native group-commit
contract: `commit(batches, receive, context)` returns the stored prefix and
any refusal; `receive(index, seq)` acknowledges each stored batch in order.
A driver failure can leave an uncertain outcome and fails the Session.
`subscribeCommits` sees stored commits. Conversation observations also see
progress committed in memory before storage; by default, deferred progress
can wait up to 1,000 ms before persistence. Hosts can choose
`settings.progress.persistWithinMs: 0` when they require immediate storage.
OAR's observation records are not a claim that every partial is already
durable. Host extensions must follow the native 1.5 task, hook and document
contracts. See the [native changelog](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/CHANGELOG.md).
The checks below cover JSONL migration and MemoryStorage, not arbitrary
custom drivers, SQLite upgrades or host extensions.

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
import this adapter and load without its optional peers. It is absent from
`defaultRuntimes` and the CLI: the host must supply its Harness. `installation()` reports bundled and
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
| `session({ resume })` | conversation lookup, configure, `observeConversation`, `Harness.resume()` | Attaches to saved work and enables scheduling of unfinished tasks; no new input is submitted |
| `prompt` | `submit({ whenBusy: "reject" })` | Fresh input while locally running is refused busy; an unseen native run is runtime_refused |
| `steer` | `submit({ whenBusy: "steer" })` | Joins an active run at its next input boundary; idle requests are refused |
| `queue` | `submit({ whenBusy: "followUp" })` | Durable follow-up input; `capabilities.queue.durable` is true |
| `withdraw(inputId)` | lookup by request id, `submission.abort()` | Accepted only while native cancellation says `aborted`; already placed/settled or missing is `not_queued` |
| `abort` | `conversation.abort()` | Stops the native run and its pending inputs; outcome comes from native submission receipts |
| `dispose` | `observation.detach()` | Detaches this controller, preserving the conversation, running work, storage and Harness |

Dispose is idempotent and records an accepted response. It emits no process
exit and does not infer a turn outcome. To stop work, call `abort` before
`dispose`. The host closes its Harness when appropriate. Closing a Harness
stops its invocations but leaves durable work recoverable; opening an OAR
Session resumes that scheduler. Recovery may repeat an interrupted provider
request or a replayable tool, so submission deduplication is not a promise of
exactly-once external side effects. Extension replay policy remains native.

If observation ends without this controller disposing it (`stopped`,
`aborted`, `ended`, `failed` or `listener_error`), its native `WatchEnd` is
retained in a frame, followed by an `exited` response with code null. This
ends the observed turn and makes later controls return `runtime_exited`; it
does not claim that shared Harness execution stopped. A normal Harness close
currently reports `failed` with `Error("session closed")`; a storage failure
retains its actual error and requires reopening the host Harness.
A failed submission query is an error frame, preserving observation without
guessing a terminal outcome. API, storage and listener errors retain JSON-safe
`name`, `message` and a scalar `code` when present, without Error objects or
cause chains, including when the original cause is cyclic.

Fresh prompts use the session status immediately before their request: running
means local `busy`, without submitting; idle never returns `busy`. If another
controller started work before the watch caught up, native `ConversationBusy`
is `runtime_refused` with the native message. A previously submitted inputId
is instead accepted as a retry, even while running, without new submission.

Admission uses native submissions and the record fold, not the SDK/RPC
adapter's run flag or held FIFO: on Durable 1.5.2 an idle `turn_ended`
observer can submit the next prompt, which stays busy until the new native
run ends ([native terminal-observer test](../../sea-trial/vendor/pi-turn-admission.vendor.test.ts)).

An open or resumed snapshot with a run emits `turn_active`, making status
running before any model output. It creates a view turn only if none is
already open. A native run appearing after an OAR prompt therefore does not
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

### Run liveness and recovery

A run stays busy while native `afterRun` work finishes, even after its input
receipts are already `done` and `run.inputs` is empty. OAR waits for that run
to end; an observer attached during this wait also adopts it as running. A
queued follow-up can replace the ending run in the same publication. OAR
uses the native deletion of `pi.live.run` to separate the two turns; changing
only `run.taskId` between model rounds is not a turn boundary.

In 1.5.2, repeated process interruption settles built-in tasks instead of
leaving the 1.4 parked state. The [restart probe](../../experiments/pi-durable-parked-task.ts)
observed four interrupted provider attempts followed by a native
`unanswered` receipt with reason `interrupted`. A new controller sees the
saved conversation idle and does not replay that historical failure as a new
turn. A new input can run normally. There is no `retryTask` recovery API in
this version. The [1.4 parking report](../../experiments/pi-durable-parked-task.md)
is historical evidence, not the current host contract. Retry and replay
policy remain the host Harness's responsibility.

## Options, models and instructions

`model` is `provider/model`, resolved against the supplied catalog. `effort`
is a supported native thinking level; OAR validates it against that model's
menu. Both are applied and read back before returning. `listModels` reads
`Models.getModels()`, including entries whose credentials may be unavailable;
it does not authenticate or turn an empty catalog into `unauthenticated`.
OAR installs no providers or keys. The host owns those decisions.

A different or missing model in the opened agent snapshot throws
[`ModelConfirmationError`](../spec/runtime-matrix.md#model-confirmation-failures),
with `requested` and the reported `provider/model` (or `null`). Resolving one
model through `getModel` supplies no `catalogSelectorIds`; an unregistered
model keeps its earlier `RuntimeFailureError("model_unavailable")` refusal.

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
concatenating it again. `systemPrompt` replacement is refused. This differs
from [Pi SDK/RPC sessions](pi.md), which require prompt options again on
resume and return to the default prompt when they are omitted.

Resume configuration is transactional. While adopting an active run, supplied
cwd/model/effort/instructions must match its saved settings; changed values
are refused before mutation. Reopen after the run finishes to change them.
The runtime also refuses `env`, `launchArgs`, `serviceTier`, `mcpServers` and
`disallowedTools`. Environment and extensions belong to the host Harness;
there is no verified per-conversation OAR channel for these options. `goals`
is refused because this interface exposes no structured native goal controls,
and `endTurnProcessesOnAbort` because the Harness runs in the host process,
with no OAR-owned process tree. `name` is refused because Pi Durable exposes
no session name. Local-file image
input is refused whole (`capabilities.images: false`).

## Records, snapshots and limits

Every native value notification is one `pi-durable/view` frame containing
only the original `{ ops, retired }` as `native`. Unknown documents and
operations remain in those deltas. Only the initial `snapshot` frame carries
the complete `ConversationView`. To reconstruct native state, retain that
starting snapshot and every subsequent delta in order; a retained suffix
without its starting snapshot cannot reconstruct a complete view. Observation
closure is a `pi-durable/watch_closed` frame, not evidence of a process exit.
Submission queries are separate `pi-durable/submissions` frames; their
terminal receipts determine the ending run's outcome in the corresponding
view frame. A missing receipt or failed query cannot prove completion.

| Native fact | OAR reading |
|---|---|
| `pi.live.run` present at attachment or newly started | `turn_active` |
| old run removed, terminal submission receipts | `turn_ended`: done → completed; unanswered/aborted → aborted; other unanswered → failed |
| answered run's `afterRun` wait ends | completed, including for a controller attached after the input receipts settled |
| `generation.message` and appended assistant entries | text and reasoning suffixes without duplicating completed blocks |
| appended user entry | `user_message`, native entry id and inputId where a submission names that entry |
| running model or nested tool slot | tool name, call id and available arguments |
| changed running tool `output` | whole retained native output window; diagnostics/details stay raw |
| tool slot changes to done | model call reads content and ok/failed from its result entry; nested call reads ok/failed from its summary; absent result stays unknown |
| running slot disappears | ends the call; result stays unknown unless a native result entry was published |
| unstarted pending slot disappears with an aborted result entry | emits that result without inventing a tool start |
| `pi.agent` | model and effort actually stored |
| `pi.usage` | own model and tool ledgers minus totals at attachment |
| `generation.retry` | retry with native attempt and reason |
| new blocking `compactions` entry | compaction started with native trigger; failure detail stays raw |

Nested calls have their own call ids, parent task links, arguments and
summaries. Their completed structured results belong to their caller's task
documents and may be retired with that task. A conversation observation no
longer includes `structuredOutput.exitCode`, even for nested CodingTools.
OAR leaves `exitCode` absent for both nested and model-issued calls; it does
not parse diagnostic text or race a retired task document. The
[native exit-code test](../../sea-trial/vendor/pi-durable-exit-code.vendor.test.ts)
verifies that actual caller results contain 0, 7 and POSIX SIGTERM's 143 while
the projected events omit codes. Nested `isError` remains available in the
live summary. The richer 1.4 event stream is preserved only in historical
records, not synthesized by this adapter.

The optional `reasoning` counter in each model or tool usage entry is part
of its output. OAR sums the reported parts and subtracts the attachment
snapshot's reasoning total, just as it does for input, output and caches.
Missing counters stay absent; unchanged totals emit no new usage event and
repeated cumulative ledger reports do not add the same spend again. This uses Pi Durable 1.2.0's native `UsageState`
and pi-ai `Usage`, verified by projection tests.

Native model rounds are internal to a run. OAR ends the old turn before
activating its queued successor, even when both changes share a notification.
It retains the old run's input ids when native `afterRun` clears that list,
and resets them when the next run starts. Whole-document replacements and
retired deltas use native first-entry/input identity to detect a handover;
a changed task id alone is only a model-generation change.

A view keeps a bounded entry window and current state. Completed history is
**not** replayed as newly observed text or events on attachment. New entry
appends remain in native delta operations even if that same notification
trims the window; OAR reads those appends so trimming does not drop new text.
Current partial output and running tools are adopted. Buffered callbacks
retain their original order, without synthesizing the removed 1.4 events or
substituting a latest snapshot for missing revisions. A native text correction
that does not extend observed text stays raw because OAR has no
text-replacement event.

The chosen watch covers one conversation. Pi Durable can create child
conversations, but this watch does not include their events; attribution is
`opaque`, with no inferred child graph or child usage. Context occupancy,
background task projection, native history navigation, child subscriptions
and manual compaction (`manualCompaction` is not declared) are not exposed.
Host applications persist their OAR records to render a continuous transcript across controllers; native storage and OAR records
remain distinct artifacts.

Reconstructing the native view requires the initial snapshot and every later
view delta. With `retainedBytes` configured, record retention clears the oldest
frame payloads first, so the large initial snapshot can disappear early.
Neither `records()` nor cursor replay can reconstruct the native view after
that payload has been discarded. A cursor starting after the snapshot also
lacks the starting view, even without a retention limit. Hosts that need native
view reconstruction must observe records live from seq 0 and persist the
snapshot and every delta themselves. Delta recording does not change OAR's
projected events. The existing `retainedBytes` elision rules still apply to
native and tool payloads.

## Evidence and verification

Native sources: [v1.5.2 README](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md),
[conversation views](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/src/harness/view.ts)
and [live state](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/src/harness/live.ts),
checked against installed 1.5.2 on 2026-11-15. The
[migration report and reproducer](../../experiments/pi-durable-native-watch/README.md)
include a held async listener versus the synchronous observer, JSONL upgrade
and old-version refusal, nested result visibility, run replacement and
repeated process interruptions. The [native probe](../../experiments/pi-durable-probe.ts)
checks persisted instructions and deduplication after JSONL reopen.

`OAR_TEST=pi-durable-aimock pnpm sea-trial` runs the public contract against
the real SDK with a local scripted provider.
`OAR_TEST=pi-durable-aimock pnpm vitest run sea-trial/vendor/pi-durable*.test.ts`
covers steering at a tool boundary, follow-ups, withdrawal, native abort,
provider errors, active adoption, disposal, JSONL recovery, request
deduplication, buffered callbacks, afterRun adoption, storage failure closure, nested tool
results and adoption, and unavailable structured command exit codes. Pure projection, option and
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

## Orientation query costs

`listModels()` reads the host-supplied Models catalog. OAR starts no
native process or model turn for this reader. Any dynamic catalog source and
its cost are owned by the host. Installation is host-bundled; no auth-status or
provider-auth reader is inferred from the Harness's ability to list models.

## Reader environment

Installation and model listing observe the host-owned Harness and model
catalog. Both reject a nonempty `env` with `UnsupportedOptionError("env")`;
an empty map preserves existing behavior. See
[reader environments](../spec/orientation.md#environment).
