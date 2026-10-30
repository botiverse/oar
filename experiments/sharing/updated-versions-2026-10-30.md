# Updated shared-process evidence, 2026-10-30

Runtime version check: 2026-10-30.

Kimi 2.4.1, OpenCode 2.2.3 and Antigravity 1.4.5 meet the evidence gate on
Linux x64, macOS arm64 and Windows x64. Codex 0.166.0 still needs corrected
cross-platform fault observations and a complete Windows resource comparison.
Qoder 1.1.81 still needs its Windows resource comparison. These findings do
not enable an adapter or inherit evidence across runtime versions.

## Sources and complete matrix

[Run 41090160323](https://github.com/botiverse/oar/actions/runs/41090160323)
tested the four updated runtimes. The separate
[run 41090168754](https://github.com/botiverse/oar/actions/runs/41090168754)
measured only Qoder Windows resources. Both used main commit
`5e756fa4cb4d1dee2aea7e0a9c9423f25dfbb2f1`, Node 24, disposable configuration
and scripted local providers, with native tools, protocol and persistence.
Neither run used paid models or real account credentials. Windows probes
first prepared PowerShell/CIM, as recorded by the workflow.

Each artifact is named `shared-evidence-<runtime>-<platform>` and contains
separate observation and resource evidence files. Selected observation flags
and every post-turn resource window are retained in
[selected-updated-2026-10-30.json](selected-updated-2026-10-30.json), without
transcripts, paths, arguments or account fields. Antigravity Windows did not
report a native version string; its version is the workflow's pinned 1.4.5
official asset, not an inferred version readback.

| Runtime/version | Platform | Observations passed | Resource cohorts complete | Artifact ID |
| --- | --- | --- | --- | --- |
| antigravity 1.4.5 | Linux-X64 | 7/7 | 2/2 | 12993012795 |
| antigravity 1.4.5 | Windows-X64 | 7/7 | 2/2 | 12993956872 |
| antigravity 1.4.5 | macOS-ARM64 | 7/7 | 2/2 | 12994048978 |
| codex 0.166.0 | Linux-X64 | 8/9 | 4/4 | 12994780095 |
| codex 0.166.0 | Windows-X64 | 9/9 | 3/4 | 12993976713 |
| codex 0.166.0 | macOS-ARM64 | 8/9 | 4/4 | 12993039434 |
| kimi 2.4.1 | Linux-X64 | 7/7 | 2/2 | 12993557017 |
| kimi 2.4.1 | Windows-X64 | 7/7 | 2/2 | 12994001302 |
| kimi 2.4.1 | macOS-ARM64 | 7/7 | 2/2 | 12997591744 |
| opencode 2.2.3 | Linux-X64 | 7/7 | 2/2 | 12994545541 |
| opencode 2.2.3 | Windows-X64 | 7/7 | 2/2 | 12993392548 |
| opencode 2.2.3 | macOS-ARM64 | 7/7 | 2/2 | 12997335467 |
| qoder 1.1.81 | Windows-X64 | not rerun | 1/2 | 12994825384 |

The failed Codex observation on Linux and macOS was
`processExitWithTwoActiveThreads`, with `kill ESRCH`; the other eight groups
passed. Windows passed all nine observation groups but completed only three
of four resource cohorts. A failed group remains failed even if a later local
probe succeeds. Expected native refusals count as passing observations only
when their assertions succeed; they are not successful resume operations.

## Resource comparisons for the three complete updated versions

Each cohort opened ten sessions, ran one scripted turn per session, settled
for five seconds and measured three five-second windows. Values are median
(minimum to maximum). Memory is whole-tree MiB, using Windows working set
and POSIX RSS. CPU is percent of one core. Only intervals without exited
processes support the CPU comparison; all windows below satisfy that rule.

| Runtime | Platform | Isolated MiB | Shared MiB | Isolated CPU % | Shared CPU % |
| --- | --- | --- | --- | --- | --- |
| antigravity | Linux-X64 | 4851.29 (4851.29 to 4856.05) | 1893.63 (1893.63 to 1895.44) | 0.80 (0.80 to 1.20) | 0.20 (0.00 to 0.20) |
| antigravity | Windows-X64 | 3068.33 (3054.22 to 3072.80) | 1479.92 (1479.62 to 1480.20) | 0.52 (0.26 to 0.52) | 0.00 (0.00 to 0.00) |
| antigravity | macOS-ARM64 | 3469.59 (3450.83 to 3512.05) | 1775.34 (1775.31 to 1775.34) | 0.99 (0.79 to 1.19) | 0.20 (0.00 to 0.39) |
| kimi | Linux-X64 | 3338.91 (3334.66 to 3339.53) | 383.12 (381.87 to 383.12) | 3.59 (3.19 to 72.60) | 0.40 (0.40 to 13.37) |
| kimi | Windows-X64 | 2748.12 (2747.96 to 2759.18) | 287.56 (287.52 to 287.89) | 15.42 (7.98 to 23.05) | 2.06 (1.29 to 9.01) |
| kimi | macOS-ARM64 | 2723.03 (2721.47 to 2723.75) | 430.89 (425.52 to 432.64) | 31.11 (8.48 to 38.26) | 13.09 (1.38 to 13.95) |
| opencode | Linux-X64 | 3580.20 (3574.57 to 3644.97) | 393.07 (389.49 to 395.07) | 7.38 (6.59 to 16.15) | 2.79 (2.00 to 2.99) |
| opencode | Windows-X64 | 3704.89 (3700.47 to 3707.84) | 379.41 (379.31 to 379.98) | 10.78 (9.38 to 12.51) | 2.60 (1.81 to 3.62) |
| opencode | macOS-ARM64 | 3846.48 (3841.03 to 3848.20) | 477.22 (477.16 to 477.28) | 7.76 (7.76 to 21.01) | 2.17 (1.19 to 4.33) |

All nine complete pairs have lower shared median memory and lower shared
median idle CPU. This is a short scoped measurement, not a promise about
active workloads or every individual sample. Antigravity retains per-session
helpers and saves less memory than the other two runtimes. Prior versions,
previous failures and their corrections remain in the
[earlier admission report](admission-2026-10-30.md).

## Codex 0.166.0 crash selection and product cleanup

The npm launcher now uses `process.execve` on POSIX when available, replacing
the launch process with the native binary. Windows retains the child-process
path. Selecting the launch root's first child therefore no longer identifies
the runtime reliably. On xxwork, the observed launch root was `codex` and its
first child was a transient Git process. The original matrix's `kill ESRCH`
is consistent with that helper exiting before injection; the old probe did
not record its image, so its exact failed target cannot be reconstructed.

The corrected probe examines only its owned launch root and direct children,
selects exactly one `codex` executable and verifies PID plus start identity
again before injecting the fault. Missing or ambiguous candidates fail the
observation. `processIdentities` retains the candidate executable basenames
and identities; the fault result retains the actual selected identity.
No arbitrary first-child fallback remains.

On xxwork Linux x64, the corrected Codex 0.166.0 probe passed all nine groups,
including rejection of both pending thread requests after the native process
was killed. Separately, the existing product test
`sea-trial/vendor/stuck-runtime-tools.vendor.test.ts` passed against that same
binary: it stops the runtime with an active tool in a separate process group,
disposes the OAR session and requires the observed tool tree to be gone.
This verifies OAR product cleanup on the local platform; it does not replace
Windows/macOS results or supply the missing Windows resource cohort.

Reproduce the local product check with the exact binary:

```sh
OAR_TEST=codex-aimock OAR_TEST_REQUIRE_AVAILABLE=1 OAR_CODEX_BIN=/absolute/codex \
  pnpm exec vitest run sea-trial/vendor/stuck-runtime-tools.vendor.test.ts
```

## Qoder Windows loaded query and measurement correction

The Qoder Windows run prepared PowerShell in about 1.66 seconds and CIM in
about 0.35 seconds. Its ten isolated sessions then used about 4,546 to 4,949 MiB
and 214 to 225 percent of one CPU core across three post-turn windows. During
fixture cleanup a product process-table query exceeded its five-second
limit at about 5.3 seconds. Shared measurement never started. Codex Windows
also lost one shared cohort to a five-second process-table query timeout.

These observations establish a deadline overrun after preparation. Memory
pressure or I/O contention is a hypothesis, not a measured cause. The earlier
CPU stress experiment did not reproduce the sustained slowdown. Task #97
retains this distinction, and OAR's product query timeout is unchanged.

The experiment now owns its subprocess-backed table and resource readers,
with a 60-second bound and actual wall-time observations. CIM also reports
query-only elapsed time. Each attempt is printed and appended to
`process-table-reads.jsonl`, including failed attempts. Failed reads never
become empty tables or successful fallback samples. Linux reuses procfs
structural validation without imposing a subprocess deadline. Cleanup errors
are saved alongside the last resource cohort before the probe exits nonzero;
it does not start another cohort after cleanup fails.

The next evidence run must rerun Codex 0.166.0 observations/resources on all
three platforms and Qoder 1.1.81 Windows resources. Until those results exist,
both gaps remain missing. Wider experiment budgets provide timing evidence;
they do not change product guarantees or justify a product deadline increase.
