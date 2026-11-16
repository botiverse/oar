# Pi Durable native conversation observations and storage migration

2026-11-15, Linux x64, Node 24.19.0. Durable, Chord and the host model catalog
use 1.5.2; OAR's bundled coding-agent SDK and normal Pi AI stay on 1.5.0.
All model traffic is faux or loopback aimock. No account or host storage was
used. This is the separate Durable migration requested in task #158, not a
Pi SDK/RPC upgrade.

## Decision and native evidence

Use `Harness.observeConversation`, enqueue each original callback, then
project outside the native publication line. `Conversation.watch()` alone is
not an ordered event substitute: with its first listener held while a complete
run executes, it delivers two callbacks and never exposes that run; the
synchronous observer receives six callbacks and sees both boundaries.
[Selected evidence](selected.json), `observerComparison`, preserves those
actual calls, not reconstructed 1.4 events. [probe.mjs](probe.mjs) reproduces
the comparison.

The [native view implementation](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/src/harness/view.ts)
mounts built-in documents and a bounded entry window. It publishes every
change to synchronous observers, including progress held in memory before
persistence. The adapter keeps the initial view once and then the original `ops` and `retired`,
buffers callbacks that precede attachment resolution, and never calls native
reads or record listeners from that synchronous callback. Entry append
operations retain new entries even if the same update trims the view window.

A final boundary can delete `pi.live.run` and set a queued successor in one
publication. The queued tool-run control initially projected only one turn
end, revealing that comparing only busy/idle state loses this boundary. The
adapter now uses the native deletion operation; changing only `run.taskId`
is a generation handover inside the same run. `queuedBoundary` in the
selected evidence contains the original delete/set operations and new run.
The existing native control retains its two-end assertion and three tool
results. Outcomes use the old run's complete receipt list, including absent
receipts; a partial list of done receipts cannot establish completion.

An answered run may retain `afterRun` work with an empty input list. Both an
existing controller and a newly attached one stay busy until that native run
ends, then report completion. The native document explicitly means the run
has already answered. This is covered by the
[observation boundary test](../../sea-trial/vendor/pi-durable-observation.vendor.test.ts),
along with callbacks delivered before the attach promise resolves. The
[terminal-observer control](../../sea-trial/vendor/pi-turn-admission.vendor.test.ts)
still admits a new prompt from the completed-turn observer without reentering
the native transaction line.

## Changed host facts

1. **Storage cannot be rolled back in place.** The JSONL control creates a
   1.4 conversation, saves a backup, reopens it with 1.5.2 and verifies the
   same instructions and deduplicated receipt. That read/dedup-only reopen
   leaves it readable by 1.4. New work under 1.5.2 writes `pi.live` v3; 1.4
   then refuses with `Document 2 (pi.live) has newer version 3 than 1`.
   Reopening the backup made before the upgrade with 1.4 still works. The seven phases
   and exact receipts are under `migration` in selected evidence. Hosts must
   back up before upgrading and restore that backup for rollback. No SQLite
   or arbitrary custom-driver migration was tested.
2. **Custom Storage has a group-commit API.** Native
   `commit(batches, receive, context)` acknowledges stored batches in order
   and returns a stored prefix plus any refusal. A driver error may leave an
   uncertain outcome and fails the Session. Progress observations can precede
   durable storage; the native default persistence window is 1,000 ms.
   These are source/API facts from the installed 1.5.2 declarations and
   [changelog](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/CHANGELOG.md),
   not a claim that a custom driver passed the JSONL control.
3. **Nested structured exits are no longer observable here.** A tool caller
   receives `{ exitCode: 7 }`, but the conversation slot retains only
   `isError`, duration and error summary. After the parent finishes,
   `NestedCallDoc` is retired. `nestedResult` preserves the caller's result,
   completed native call and missing post-run document; [nested.mjs](nested.mjs)
   reproduces it. OAR preserves `isError` and leaves exitCode absent for both
   nested and model-issued calls. The actual CodingTools test still verifies
   caller codes 0, 7 and POSIX SIGTERM 143, while asserting absent projected
   codes. It does not parse diagnostic text or infer codes from summaries.
4. **Restart parking was removed.** The updated
   [process-death probe](../pi-durable-parked-task.ts) kills four of its own
   provider invocations; the next reopening settles the saved input as
   unanswered/interrupted. A new controller is idle without fabricating a
   fresh historical turn end, and a new input completes once. The old
   [1.4 parked/retryTask report](../pi-durable-parked-task.md) remains historical
   evidence. These native APIs are absent in 1.5.2.

The host continues to own models, registry, scheduling, storage and execution
environment. Disposal only detaches OAR. Model/tool rounds remain one run,
child conversations remain opaque, and the browser entry adds no Node import.
The supported optional peer selection is `~1.5.2` for Durable and Chord,
resolved to exactly the same version;
custom extensions must follow their native migration instructions.

## Reproduce

The main repository checks use its installed 1.5.2 set:

```sh
OAR_TEST=pi-durable-aimock pnpm vitest run sea-trial/vendor
OAR_TEST=pi-durable-aimock pnpm sea-trial
pnpm tsx experiments/pi-durable-probe.ts
pnpm tsx experiments/pi-durable-parked-task.ts
pnpm durable-demo:smoke
pnpm run build
pnpm run clean-install
CI=1 pnpm run check
```

Use isolated package roots for the old-version control. Never point this
probe at a host's real storage. `old` and `new` below are directories with
package.json and locally installed native dependencies; use npm's `--prefix`
option to install Durable, Chord and Pi AI 1.4.0 in `old`, and 1.5.2 in `new`.
The Node flag makes the selected package root the ESM resolution base.

```sh
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs new fresh create
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs old migration create
cp -a migration backup140
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs new migration reopen
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs old migration reopen
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs new migration advance
# Expected refusal, exit 1:
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs old migration reopen
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/probe.mjs old backup140 reopen
node --experimental-import-meta-resolve experiments/pi-durable-native-watch/nested.mjs new nested.json
```

Each probe writes full native capture files. Copy each phase's file before a
later invocation of the same mode overwrites it. The selected evidence lists
full-source byte sizes and SHA-256 hashes; complete raw captures, migration
stores, backup, logs and failed preliminary attempts are retained locally.

## Validation and limits

The initial `CI=1 pnpm run check` passed type checking, lint, 4,374 tests and
18 mock behavior cases.

The native vendor run passed 30 cases; the focused run including pure folds
and terminal-observer controls passed 59 with two other-backend cases skipped.
The public Durable behavior suite passed 18 with account usage skipped.
JSONL reopen, migration and backup controls, nested native-result probe,
process-death recovery, Chromium demo, both package builds and packed
installation passed. The install control verifies optional peer absence,
TypeScript 6 consumption, browser bundling and coding-SDK registration
identity before and after adding Durable 1.5.2 peers.

This was not a single clean first attempt. Early probe setup errors included
using CommonJS resolution for import-only Chord, cloning a resolved Agent
containing functions, an incomplete passive-write shape, a nested structured
result without its schema, and a non-UUID public input id. Those attempts are
not runtime failures. The first migration suite found the real missed queued
boundary and abort-projection timing; it also exposed the now-visible nested
arguments and the actual normal-close Error name. The replacement
assertions describe those measured native values, while retaining the
original terminal, result, cleanup and no-fabrication checks.


## Review revision, November 16

View records now keep the initial snapshot once and each later native
`{ ops, retired }` pair. Reconstructing a native view needs that snapshot and
every following delta; an arbitrary record suffix cannot reconstruct it.
The native replay test independently observes each view and compares it with
the snapshot plus recorded operations after every publication.

[record-volume.ts](record-volume.ts) drives 30 sequential short aimock prompts,
saves every record and replays all native revisions. The same probe against
the original PR implementation produced 1,027,060 bytes. The revised adapter
produced 84,167 bytes; both captured 215 records and 91 views, and all 91
revisions reconstructed exactly. This is a separate control from the reviewer's
30-prompt workload, not a reproduction of its absolute byte count.
[Revision results](revision-results.json) retain the summaries and fingerprints
of complete local logs and record streams. No full raw stream is committed.

```sh
pnpm tsx experiments/pi-durable-native-watch/record-volume.ts /tmp/durable-revised
# Against the original PR implementation, with a fresh output directory:
pnpm tsx experiments/pi-durable-native-watch/record-volume.ts /tmp/durable-original with-values
```

Removing a running tool slot now emits its end before the old turn ends. A
missing result leaves success unknown. Native abort and parent-return controls
actually publish a failed nested summary, so those cases retain that native
failure. A pending call that never starts can still have an aborted result
entry; the adapter preserves it without inventing a start. The abort control
also asserts that the final public state stays idle: an intermediate revision
emitted the tool end after the turn end and incorrectly restored running state.
That failure and its corrected regression are retained.

Whole-document replacement and retirement use run identity as a fallback to
an explicit run deletion. A changed generation task alone remains the same
run. The native `afterFailedRun: "continue"` control fails A, starts queued B
in the same publication and verifies B succeeds. A mutation that retains A's
input list makes B inherit A's failure and fails this test. That native
publication has a delete followed by a set, so the test alone also passes the
original implementation. A second variant, supplied by independent review,
replaces the `pi.live` operations in each callback with one whole-document set
while keeping the native value. With the original `456bfcef` projection it
fails because only one `turn_ended` is emitted; the revised projection emits
A failed, B completed and settles idle. This is an intentionally transformed
observer sample, not a claim that the native engine emitted compacted ops in
this run. Restoring the
original product also fails the new initial-observer cleanup, pending-tool
result and delta-replay tests. These controls cover the previously missed
regressions, not just successful paths.

The first revised complete gate passed type checking, lint, 4,377 tests and 18 mock
behavior cases. The focused native/fold set passed 41 cases; all Durable vendor
cases passed 35, with 18 public behavior cases passing. Package builds, packed
installation and Chromium smoke passed again. The packed check includes
normal Pi AI 1.5.0 beside the Durable host's aliased 1.5.2 and verifies OAuth
registration identity. No real account, provider charge or host store was used.

After adding the compacted observer variant and rebasing onto the Pi bootstrap
test follow-up, the complete gate passed again with 4,379 tests and 18 mock
behavior cases. All five native observation cases passed, including both
delete/set and whole-document-set run transitions. The retention docs now
state that `retainedBytes` can discard the initial snapshot; native-view
reconstruction needs a live observer from seq 0 that persists every payload.
