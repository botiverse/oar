# Windows cleanup assertion audit

The cancellation snapshot still has a 1,000 ms product budget. A successful
Windows preparation query does not guarantee that a later snapshot finishes
within that budget. Tests must distinguish observed cleanup from an explicit
failure to verify it, while continuing to check actual process lifetimes.

## New evidence

On November 17, 2026, the positive background-query control failed in
[run 44070175170, job 133994085024](https://github.com/botiverse/oar/actions/runs/44070175170/job/133994085024),
at `fbd4faf10d5828f4dc110e44eeec0a0358e6acb5`:

- First foreground query: 565.076 ms, successful capture.
- Second request to query entry: 0.149 ms; query duration: 1,193.947 ms.
- Second caller returned `timeout` at 1,026.864 ms with `timeoutMs: 1000`.
- Exit reported `before_cancel windows: timeout (1027 ms)` and unverified
  cleanup. The test demanded two successful observations and failed before
  checking the actual descendants.

The query was already running, rather than waiting behind another query.
Its duration includes reader startup and decoding; this does not isolate CIM
execution or establish slower process termination. The failed job's own
queue diagnostic supplies this evidence, not the separate eight-case timing
archive. [Selected diagnostic](queue-timeout-2026-11-17.json).

## Assertion rule

[The test helper](../../tests/fixtures/cleanup-evidence.ts) reads the same
cleanup instance used by the operation. It changes no query, product timer,
signal or retry. There must be exactly one managed tree in the session
fixtures. No preparation result or another process's timeout can excuse an
unverified exit.

For an otherwise successful native control, every failed observation must
be a Windows `timeout`, carry the unchanged phase budget and record elapsed
time at least that budget. Pre-EOF retries may use only the remaining part
of the existing five-second capture budget. Missing roots, command errors, missing evidence,
wrong phases, an omitted warning and a false `observed` claim fail. The exit
warning must describe all the recorded failures exactly. Explicitly injected
negative controls allow only their known timeout positions on other systems.

The orphan checks remain independent of exit reporting:

- A captured orphan with successful revalidation must actually disappear.
- An orphan whose capture timed out must remain unclaimed after its parent
  exits. The fixture finalizer then reaps it separately.
- A recorded revalidation timeout cannot prove that a captured tool was
  signalled. The test records its actual liveness and requires the unverified
  exit; it does not report cleanup success.
- Root and intermediate-parent exit checks, native turn outcomes and the
  single-exit invariant remain mandatory.

The helper writes metadata and actual orphan-liveness results after each
case to `oar-trial-run/cancellation-timing/cleanup-*.json`, covered by the
existing Windows artifact upload. These files contain no process tables or
PIDs. The earlier timing traces remain separate. Passing tests retain this
evidence even when the reporter suppresses console output.

## Audit coverage

The audit searched unit and vendor tests for cleanup status, warning absence,
successful observations and actual descendant-exit assertions.

| Test group | Treatment |
| --- | --- |
| `cancellation-observation-queue.test.ts` | Validate both captures separately, retain the deliberate first-query expiry, require each captured orphan's reclamation and each missed orphan's survival. |
| `cancellation-orphan-cleanup.test.ts` | Apply the same rule to both resumed turns, immediate native root exit and kill fallback, for ACP and stream-json. Keep the controlled expiry and next-turn routing assertions. |
| `acp/acp-orphan-cleanup.test.ts` | Disposal uses the pre-EOF capture. Validate its own evidence and the resulting orphan lifetime. |
| `process-orphan-cleanup.test.ts` | Validate prepared and ordinary shutdown evidence, including the explicit unreadable control. Ordinary shutdown's direct parent/tool exit checks remain strict. |
| `process-cleanup.test.ts` native recovery case | The deliberate first EIO remains required. Only subsequent recorded native timeouts can explain failed recovery. Synthetic failure and PID-reuse assertions remain exact. |
| `windows-capture-budget.test.ts`, `probe-cleanup.test.ts`, pure `process-cleanup.test.ts` cases | Synthetic tables and clocks; exact status, signalling, retry and deadline assertions stay unchanged. |
| `acp/acp-output-cleanup.test.ts`, `acp/acp-shared-eof-cleanup.test.ts` | Explicit POSIX controls, not Windows assertions; unchanged. |
| `adapter-eof-cleanup.test.ts`, `process-shutdown-order.test.ts`, `acp/cancellation-observation.test.ts`, `stream-json/cancellation-observation.test.ts` | Deliberate failures and controlled interleavings; exact failure propagation, cancellation and deadline assertions remain unchanged. |
| `process-async-cleanup.test.ts`, `process.test.ts`, `process-host-exit.test.ts`, `session-dispose.test.ts`, `windows-auxiliary-cleanup.test.ts` | Assert actual owned-process exit, response ordering or native tree termination rather than a successful cancellation snapshot. Keep those checks strict; a snapshot timeout is not a blanket exemption for a live root or a broken native tree stop. |
| OpenCode cleanup observer, Codex turn-process and sea-trial cleanup tests | Different cleanup ownership contracts or synthetic observations; no platform-wide relaxation. |

[Negative controls](../../tests/cleanup-evidence.test.ts) reject absent or
unrelated evidence, command failure, missing roots, altered budgets, a false
success claim and an unsupported POSIX timeout. Required CI supplies the
Windows native run; a Linux pass alone does not establish Windows behavior.
