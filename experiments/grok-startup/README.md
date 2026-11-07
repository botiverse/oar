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
