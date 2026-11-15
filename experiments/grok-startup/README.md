# Grok ACP bootstrap phases and repeated startup

The [November 7 closeout](../acp-ci-failures/closeout.md) keeps this probe and
its tests for a natural first-timeout/reuse sample. Successful later probes
do not explain a different suite process's initialization timeout.

This extends the existing post-suite Windows launch comparison to distinguish
binary extraction, installation into `GROK_HOME`, native spawn and the ACP
initialize response. The 15-second initialize limit is unchanged. This is
diagnostic code, not a product startup change or a retry policy.

The preceding [Windows ACP report](https://github.com/botiverse/oar/blob/cf0aaf3e2671a548084ef47b9eab5f7a6ed78986/experiments/acp-ci-failures/README.md) found one
timeout among 27 wrapper/Node startup observations. Successful observations
took 5.2 to 14.1 seconds. All 18 direct native controls completed in 1.4 to
2.2 seconds. Those observations did not include bootstrap phases or a second
attempt in the same HOME, so they cannot establish which operation was slow
or whether retrying after failure works.

## What the probe measures

[`grok-acp-startup.ts`](../grok-acp-startup.ts) keeps the five existing paths:
the OAR-resolved executable, npm wrapper, explicit Node bootstrap, direct
native binary and direct native binary with overlapped pipes. Each path gets
a fresh isolated fixture with synthetic credentials and a local provider.
Only ACP initialize is sent; no model inference is requested.

The OAR-resolved path and explicit Node bootstrap now each run twice in the
same HOME. The second attempt follows success or failure, after process
cleanup. Its `previousOutcome` distinguishes a repeat after success from a
retry after timeout or error. Binary metadata after each attempt records
canonical, versioned, backup and temporary file sizes without reading their contents
or preparing a binary for the next attempt. A fresh HOME does not imply a
cold OS file cache.

Only the explicit Node path preloads
[`trace-bootstrap.ts`](trace-bootstrap.ts). It observes the original
bootstrap's synchronous compressed read, Brotli decode, binary write, copy,
rename, symlink and native spawn calls. It neither replaces their results
nor handles otherwise unhandled spawn errors. A synchronous phase-start
record survives a kill inside an operation. Windows canonical copies have
their own duration; the parent records time to the initialize response.

Each phase file is capped at 64 KiB with an explicit truncation record.
Write failure disables recording and emits one warning without replacing
the original operation's result or exception. Records contain phase names,
relative time, byte counts and file-role labels, not file contents, absolute
paths, arguments, credentials or environment dumps. The parent retains its
existing credential-redacted stderr tail. Node 24 loads this TypeScript
preload directly; it does not require a loader package in the vendor child.

The instrumented path includes preload and synchronous logging overhead.
The uninstrumented OAR and npm paths remain comparison points. Do not
attribute a marginal 15-second timeout to the vendor without considering
that overhead and the runner's other activity.

There are now seven launches rather than five. Each retains 15 seconds for
initialize and five seconds for cleanup, at most 140 seconds across those
waits, excluding discovery and fixture setup/cleanup. The existing
three-minute diagnostic step remains unchanged. It still runs **after** the
behavior and vendor suites in `acp-windows.yml`, including after a failed
suite. It cannot prewarm those tests, and no additional workflow is launched
for CodeBuddy sampling.

## Linux control, 2026-11-06

Grok 1.0.70, Node 24.19.0, Linux x64. The source hash, raw numeric phase
measurements and all seven outcomes are in
[`linux-selected.json`](linux-selected.json). The official bootstrap file
was not modified.

| Path | First initialize | Second, same HOME |
| --- | ---: | ---: |
| OAR-resolved executable | 276 ms | 267 ms |
| npm wrapper | 273 ms | not measured |
| Explicit Node bootstrap, observed | 1,738 ms | 355 ms |
| Direct native | 272 ms | not measured |
| Direct native, overlapped pipes | 273 ms | not measured |

For the explicit Node first attempt, reading the 55,510,619-byte compressed
binary took 46.2 ms, Brotli decode took 1,174.6 ms, and writing the
195,700,192-byte temporary binary took 117.6 ms. The versioned rename and
canonical symlink operations each took less than 0.1 ms. Spawn notification
arrived 25.7 ms after the spawn call. The initialize response arrived about
269 ms after that notification. The second attempt emitted no extraction
or installation phases and initialized in 355 ms.

On this Linux installation, npm postinstall has replaced its `bin/grok`
entry with a native binary. The OAR-resolved and npm paths therefore bypass
Node bootstrap and leave no binaries in the fresh fixture HOME. They are
not equivalent to the Windows launcher paths. Linux uses a symlink rather
than Windows' canonical binary copy.

All attempts succeeded before 15 seconds. These results demonstrate phase
capture and reuse on Linux, **not** Windows startup costs or recovery from
a real first-start timeout. The first Windows measurement is below. In particular,
do not assume a partially materialized canonical binary is retryable just
because a completed first launch is faster on its second attempt.

## Windows control, 2026-11-06

The first extended observation,
[job 128124140045](https://github.com/botiverse/oar/actions/runs/42285210473/job/128124140045),
used Grok 1.0.70 and Node 24.22.2. [Selected records](windows-selected.json)
include verified artifact/source hashes, all attempts and the two phase files,
without temporary paths. The official bootstrap hash matches the Linux control.

| Path | First initialize | Second, same HOME |
| --- | ---: | ---: |
| OAR-resolved executable | 5,999 ms | 326 ms |
| npm wrapper | 5,666 ms | not measured |
| Explicit Node bootstrap, observed | 5,842 ms | 349 ms |
| Direct native | 1,531 ms | not measured |
| Direct native, overlapped pipes | 1,554 ms | not measured |

The observed first Node launch read 50,686,299 compressed bytes in 23.3 ms,
decoded 176,000,000 bytes in 723.5 ms, wrote the temporary binary in
2,333.6 ms, renamed it in 0.4 ms and copied it to the canonical executable
in 70.6 ms. Native spawn notification took 1,074.5 ms; initialize arrived
about 1,524 ms after that notification. The second launch skipped extraction
and copying, with spawn notification taking 5.2 ms.

Among separately timed bootstrap calls, the temporary binary write was
longest. These measurements do not distinguish disk work,
security scanning or scheduling within those waits. All attempts completed
before 15 seconds, so recovery after an actual first-start timeout is still
unmeasured. The whole diagnostic step took 25 seconds. The existing
three-minute limit and the suites preceding the probe are unchanged.

## Reproduce and validate

After installing official Grok 1.0.70 and the repository dependencies:

```sh
pnpm tsx experiments/grok-acp-startup.ts "$(npm root -g)"
```

`GROK_PROBE_NATIVE` can select an already installed native binary for the
two direct controls. `OAR_TRIAL_RUN_DIR` selects the artifact directory.
The output is `grok-acp-startup.jsonl` plus per-attempt JSONL under
`grok-bootstrap/`. Compare `startedAt + elapsedMs` with the last native
spawn phase, and inspect unfinished phases on a timeout. Keep the first
attempt's outcome, partial files and second outcome together.

Five controlled real-process tests cover identical bytes and native errors
with and without observation, failed trace writes, size-limit truncation,
termination inside a synchronous phase and an unhandled spawn failure.
The kill test deliberately blocks a synthetic operation; it is not evidence
of a Grok startup failure or of Windows retry behavior. The full local check
also runs these tests. Product initialization deadlines, vendor assertions,
worker limits and Windows workflow step limits are unchanged.

## Actual Windows suite processes, November 15

The post-suite comparison leaves a gap: its successful processes cannot
explain a different process that failed during a behavior or vendor test.
Windows runs 43685846860, 43689974509, 43690455097, 43690903962 and
43696273726 contained seven Grok initialize timeouts. In the last run's
later comparison, the first OAR-resolved launch also timed out, then a
second launch in the same HOME succeeded. That failed launch has no
bootstrap phase trace. This does not establish the stalled operation or
justify changing a deadline.

[`acp-windows.yml`](../../.github/workflows/acp-windows.yml) now installs
[`observe-process.ts`](observe-process.ts) in the Grok test hosts before
running the existing behavior and vendor suites. It observes the original
`spawn` and stream calls, rather than launching another vendor instance.
The observer forwards the original spawn arguments and options unchanged.
The workflow adds only the diagnostic directory variable to the two Grok
steps; fixture provider settings, pipes, timeouts, assertions and worker
count are unchanged. Kimi and OpenCode keep their existing entries.
The seven later launch comparisons are still separate controls. No product
code is changed.

The always-uploaded `oar-trial-run/grok-processes/{behavior,vendor}` contains
one JSONL trace per host/child pair and a bounded stderr sidecar. The trace
records absolute and monotonic-relative times for:

- spawn requested, returned and the OS spawn event;
- initialize, authenticate, session/new (also session/load and prompt)
  written by the host and their matching responses, including numeric
  protocol error codes;
- first stdout bytes, first parsed protocol frame, first session/update
  and first agent message/thought chunk;
- process errors, exit code and signal, close, and any requests still
  unanswered then. A host that exits before observing close records that
  fact with the status it actually observed.

`request_sent` means the host's stream write returned, including a buffered
write with backpressure. It does not prove the native process consumed the
bytes. `spawned` is the OS event for OAR's direct child; on Windows this may
be cmd.exe or the Node bootstrap, not the native Grok descendant. No authentication
request can mean the opening path never reached authentication, rather than
an authentication failure. `first_session_update` can be a plan or other
notification, not necessarily model text; `first_agent_output` separately
marks the first agent message/thought chunk. Missing exit/close after a runner
kill is missing evidence, never an inferred zero exit code.

Vendor traces include the test file/name captured at spawn. Behavior traces
identify the suite and process; a hash of the isolated GROK_HOME joins
launches from the same fixture without publishing the path. All stages in
one file belong to the same direct child PID. Stage records contain no wire payload,
request/session IDs, command arguments or environment dumps. Known
environment/authentication/MCP credentials and fixture roots are redacted
from stderr. The sidecar retains the last eight lines, each at most 512
characters after redaction; longer lines are explicitly omitted. Split
lines are buffered with a 64-KiB limit, and the last incomplete line is
saved on EOF/close. Complete lines are saved once per received chunk before cleanup. Native stderr
can still contain other runtime identifiers; publish selected evidence only.
An unfinished line can be absent if the whole host is killed first.

Protocol line parsing is bounded at 1 MiB. A larger line is skipped only
by the observer, never by the original stream. Each stage trace is capped
at 64 KiB plus terminal records and an explicit truncation row. Stderr is
stored separately so a verbose stream cannot crowd out exit diagnostics.
A diagnostic write failure prints one fixed warning and leaves the original
process result unchanged. Tapping `emit` does not introduce data listeners
or handle otherwise unhandled errors. Synchronous metadata writes and JSON
parsing still add overhead; consider that when comparing borderline times.

### Validation

Run the synthetic real-process checks on any supported platform:

```sh
pnpm tsx --test experiments/grok-startup/observer.test.ts
```

They compare bytes, stream write callbacks/returns and exit behavior with
and without observation, stop at each requested protocol stage, retain a
nonzero exit and unterminated stderr, check split-credential redaction,
trace limits, unhandled spawn errors and diagnostic write failure. The
Windows observation workflow runs these checks after the original suites,
so they cannot prewarm those suites. Synthetic stops are validation inputs,
not evidence of the native timeout's cause.

For an isolated native control with a local scripted provider:

```sh
OAR_TEST=grok-aimock OAR_GROK_PROCESS_TRACE=oar-trial-run/grok-processes/behavior \
  pnpm tsx experiments/grok-startup/behavior-observed.ts
OAR_TEST=grok-aimock OAR_GROK_PROCESS_TRACE=oar-trial-run/grok-processes/vendor \
  pnpm vitest run sea-trial/vendor --maxWorkers 2 \
  --config experiments/grok-startup/vitest.config.ts
```

Use `OAR_GROK_BIN` to select the workflow's pinned Grok 1.0.70. This does not
use a real account or model. Windows-native results remain separate from a
Linux control; neither proves which phase a future failure will stop at.

The Linux control used Node 24.19.0 and Grok 1.0.70 (f50904eaee6c):
11 synthetic checks, 17 applicable behavior cases and 29 vendor cases
passed. All 17 behavior and 31 vendor child traces reached close. A final
three-case structured-output run also passed and captured first agent
output for all four spawned children. [Selected metadata](suite-observer-linux.json)
retains a complete stage sequence, counts and original log hashes. Two
unsupported behavior cases and the 437 other-runtime vendor cases were
skipped, not passed. An initial targeted command selected a different
runtimes' structured-output file and skipped six cases; it is excluded from
these counts. No Windows result is claimed by this Linux control.


### First Windows suite run and missing-capture regression

[Run 43708553907](https://github.com/botiverse/oar/actions/runs/43708553907/job/132794882227)
on `b8f864e5` passed 17 behavior cases, 24 vendor cases and 11 observer
self-tests with Grok 1.0.70 and Node 24.22.2. The downloaded artifact
`sea-trial-grok-aimock-windows-latest` (ID 14159294299, SHA-256
`bddcbde1795568507af72f64f4a1aae537a7674b9158c1c15f616c277631d977`)
contains **no** `grok-processes` directory. The upload covers the correct
parent directory. Passing tests without those records do not validate
actual suite capture, and this run supplies no failing-process stages.

The observer previously required separate `agent` and `stdio` argv entries.
An unrecognized Windows npm shim passes through `cmd.exe /d /s /c`, where
OAR combines the quoted, caret-escaped arguments into one command string.
A synthetic launch using OAR's actual argument escaping reproduced the
missing trace directory before the matcher correction. The observer now
recognizes those command words in that shell form as well as separate argv.
Decoding is for matching only; spawn receives the original arguments.
It does not execute decoded text or log the command string. The spawn row
records only the matched form (`argv` or `cmd-string`) so a Windows artifact
can verify which form was actually used.

The workflow also checks the actual behavior and vendor capture directories
after the suites. Each suite that ran must retain process spawn evidence
and at least one sent initialize request. An absent directory, an empty
directory or only non-ACP records fails that observation check. A skipped
suite is excluded, while a failed suite keeps its original failure. This
check runs separately from the synthetic fixtures and the later launch
comparison, so their logs cannot substitute for suite evidence. Artifact
upload still runs on failure. Reproduce the capture check with:

```sh
pnpm tsx experiments/grok-startup/check-capture.ts success success
```

The synthetic observer suite now has 13 checks, including the escaped argv
regression and rejection of absent, empty and non-ACP capture. Windows
acceptance requires a run of this corrected workflow and inspection of its
actual per-process artifacts; the synthetic regression alone is not proof
of the precise command used by the earlier Windows run.
