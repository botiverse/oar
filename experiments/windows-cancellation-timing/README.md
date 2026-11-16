# Windows cancellation phase timing

The one-second observation before cancellation is a product deadline. A host
that misses it cannot verify the identities of detached descendants. This
change adds internal timing diagnostics so a later Windows failure can be
separated into queue delay, an actual process-table query, cancellation and
post-exit cleanup. It changes no deadline, retry, query scheduling, process
signal, cleanup assertion or public record shape.

## What the retained failures establish

Three failed cancellation cases explicitly report that the second pre-cancel
observation exceeded its 1,000 ms budget:

| Run / Windows job | Case | First observation | Second observation | Whole case |
| --- | --- | ---: | ---: | ---: |
| [42283686326 / 128118912542](https://github.com/botiverse/oar/actions/runs/42283686326/job/128118912542) | stream-json, two resumed turns | 841.97 ms | timeout at 1,043.98 ms | 4,626 ms |
| [43791812617 / 133051720106](https://github.com/botiverse/oar/actions/runs/43791812617/job/133051720106) | ACP, two resumed turns | 675.46 ms | timeout at 1,003.15 ms | 4,776 ms |
| same job | stream-json, two resumed turns | 930.69 ms | timeout at 1,018.16 ms | 4,372 ms |

Both jobs used Windows Server 2025 image `20261103.298.1`, runner `2.338.2`.
Their setup query and first cancellation observation succeeded. First-use
preparation alone therefore does not guarantee a later query meets the
deadline. The old timeout duration measures the caller's return, not a
completed CIM query; it cannot show whether that query even started. The
identity assertion failed before the descendant-gone assertions, so these
samples do not establish slower process termination.

Four older failures lack sufficient phase data: the first-tool assertion in
[PR 580 attempt 1](https://github.com/botiverse/oar/actions/runs/41223079686/job/124601496941)
and [attempt 2](https://github.com/botiverse/oar/actions/runs/41223079686/job/124605383846),
the [immediate root-exit case](https://github.com/botiverse/oar/actions/runs/43265455583/job/131347687956),
and the [kill-fallback case](https://github.com/botiverse/oar/actions/runs/43491150693/job/132112370388).
These remain cleanup failures of unknown cause. They are not reclassified as
capture timeouts. The new collector covers those cases too.

Earlier [CIM measurements](../windows-cim/README.md) and
[dispose timing](../windows-dispose-timing/README.md) show why queue, query and
termination time must be measured separately. They do not identify the cause
of the three current capture timeouts. No failure rate is inferred from this
retained sample set, and no timeout increase is proposed here.

## Reading a new trace

[The internal event type](../../packages/oar/src/shared/executable/process-timing.ts)
uses `performance.now()` for every timestamp and deadline. Values from
different Node processes cannot be compared. The IDs below are local sequence
numbers, never operating-system PIDs or native process identities.

| Event | Meaning |
| --- | --- |
| `cancel_requested` | Associates a shutdown instance with its bounded pre-cancel observation request. |
| `observation_requested` | Caller entry and absolute `deadlineMs` on the same monotonic clock. |
| `query_queued`, `query_joined` | A query generation and the caller requests it serves; `behindQueryId` identifies its predecessor. |
| `query_started`, `query_finished` | Actual reader invocation and return, including a failed result. This includes command startup and decoding, not just CIM execution. |
| `observation_returned` | Caller return, with `ok`, `failed` or `timeout`; a late query cannot replace this result. |
| `query_caller_expired`, `query_skipped` | A caller was already expired when the queue advanced; if no live caller remains, no query starts. |
| `cancel_committed`, `cancel_completed` | OAR's cancellation bookkeeping stages, not proof that a native program accepted cancellation. |
| `stop_requested`, `root_exited` | OAR stop entry and observed native root exit. |
| `cleanup_started`, `cleanup_finished` | Post-exit cleanup entry and return after any in-flight shutdown phase. A return is not proof that all descendants are gone. |

A timeout with no `query_started` in a complete interval is distinguishable
from `query_started < observation_returned(timeout) < query_finished`. An
expired caller may share a generation with another live caller, so
`query_caller_expired` alone does not imply the query was skipped.

The final cleanup diagnostic and unchanged process-gone assertions still
decide cleanup success. Never treat `cleanup_finished` or a successful query
as equivalent to those checks. Queries unrelated to a cancellation may occur
in the same process; only explicit request/query links establish correlation.

## Retention and reproduction

[The test collector](../../tests/fixtures/process-timing.ts) retains at most
512 events in memory, with a dropped-event count and observation interval.
There is no log I/O inside a measured operation. All eight
[cancellation cleanup cases](../../tests/cancellation-orphan-cleanup.test.ts)
write the bounded trace after the test on Windows, on a failure elsewhere,
or when explicitly enabled:

```sh
OAR_CANCELLATION_TIMING=1 CI=1 pnpm exec vitest run tests/cancellation-orphan-cleanup.test.ts
```

Files go under `oar-trial-run/cancellation-timing/`, or the equivalent directory
inside `OAR_TRIAL_RUN_DIR`. The Windows `check` job always uploads this directory
as `windows-cancellation-timing`. Metadata is also logged, but retention does
not depend on reporters displaying console output for passing tests.

Only timing, event kind, local correlation IDs, source kind and coarse outcome
are collected. No PID, process table, native identity, command, environment,
account identifier or provider payload is exported. Production has no
subscriber and retains no events. Subscriber errors cannot alter cleanup.

The capture window is bounded by the test. A query finishing after it closes
has no finish event in that trace. Dropped events, a partially observed query,
or a hard worker crash before the post-test write are evidence gaps, never
zero duration or proof of no work. Timestamp collection and bounded array
insertion have a small unmeasured cost; the probe is not a timing benchmark.

## Controls and selected local evidence

[Four focused tests](../../tests/process-timing.test.ts) pin queued expiry
without starting a query, a started query returning after caller timeout,
subscriber failure/unsubscription, and root-exit/cleanup/cancellation ordering
on one clock. The first two deliberately distinguish the previously ambiguous
cases. The lifecycle control uses an unspawned `ChildProcess` object and sends
no operating-system signal. Privacy assertions exclude fixture process IDs
and native identities from emitted events.

[linux-selected.json](linux-selected.json) retains the six actual child-process
samples below from Node `24.19.0`, Linux, November 16, 2026, on base `90740575`.
Each sample includes a SHA-256 fingerprint of its complete local trace. The
two controlled query-stall cases also passed but their frames are not copied
into this evidence file. All retained samples have zero dropped events.

| Case | Pre-cancel caller duration | Post-exit cleanup duration | Retained events |
| --- | ---: | ---: | ---: |
| ACP, immediate root exit | 23.33 ms | 31.96 ms | 15 |
| ACP, two resumed turns | 58.26 / 27.76 ms | 23.12 ms | 28 |
| ACP, kill fallback | 36.45 ms | 33.62 ms | 19 |
| stream-json, immediate root exit | 30.19 ms | 39.20 ms | 15 |
| stream-json, two resumed turns | 26.46 / 48.04 ms | 26.12 ms | 28 |
| stream-json, kill fallback | 34.76 ms | 25.72 ms | 19 |

These Linux controls validate collection and retention, not Windows latency.
The focused native lifecycle group passed 23 tests, and the final retention
run passed all eight cleanup cases. All 16 scripted-provider behavior backends
passed 274 cases, with 30 capability skips and no failures. The final commit
gate passed type checking, lint, 4,386 tests and 18 mock behavior cases;
`actionlint` also passed. [Validation metadata](validation.json) records the
exact base, native pins, summaries and retained local-log fingerprints. An
earlier gate caught a missing `pgid` in the newly added synthetic fixture;
that fixture was corrected, and the failed log remains retained.

Windows samples from the unchanged CI budgets are the next evidence needed
before considering a product policy change.
