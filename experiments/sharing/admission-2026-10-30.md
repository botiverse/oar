# Shared runtime admission evidence, 2026-10-30

Runtime version check: 2026-10-30.

The native observations passed for all six pinned runtimes on Linux x64,
macOS arm64 and Windows x64 in the second run. The evidence gate is met for
Antigravity 1.4.4, Grok 1.0.70, Kimi 2.4.0 and OpenCode 2.2.1 on those
platforms, and for Codex 0.165.0 on all three after the Windows resource
follow-up below. Qoder 1.1.81 meets the gate on Linux x64 and macOS arm64; its
Windows resource comparison remains incomplete. These are
evidence decisions, not implementation: no native adapter enables sharing yet.
Other versions and unmeasured platform/architecture pairs remain unverified.

## Provenance and method

| Run | Commit | Overall workflow result | Meaning |
| --- | --- | --- | --- |
| [40977768820](https://github.com/botiverse/oar/actions/runs/40977768820) | `70229b48a42e8688eb911d4985cf0bf3ce58d927` | Failed | Linux complete; Windows/macOS probe defects and setup failures left gaps. |
| [40994376921](https://github.com/botiverse/oar/actions/runs/40994376921) | `189c9c712f0738b0b636df7a2f6fd76f7270f8d8` | Failed | All native observations passed; Windows Codex/Qoder resource probes failed. |
| [41063229973](https://github.com/botiverse/oar/actions/runs/41063229973) | `2764bf58e37cf727ae6bd1a89d6484e1da3df9cd` | Failed | Windows resources only: Codex complete; Qoder isolated complete, shared query timed out. |

Each matrix cell used a separate GitHub runner, Node 24, the pinned native
executable and disposable configuration. Models were scripted local providers;
protocol handling, persistence, tools, MCP and child sessions were native.
No real account or paid-model capacity was used. Artifacts are named
`shared-evidence-<runtime>-<runner OS>-<architecture>`; each contains separate
observation and resource `evidence.json` files, except the resources-only
follow-up, which contains resource evidence only. The workflow retains them for
14 days; the tables below preserve the selected results independently.

An observation passing means its assertions held, including expected native
refusals. It does not mean every resume attempt succeeded. The
[Codex report](codex-2026-10-29.md) and
[ACP/Qoder report](acp-qoder-2026-10-29.md) explain the controls and outcomes.
The [portability report](portability-2026-10-30.md) records the first run's
failures and the corrections; they are not erased by the second run.

## Every matrix cell

`N/N` is the number of successful named observation groups. Resource
`complete` means every planned cohort produced all three post-turn windows.
Codex uses four cohorts (isolated/shared/shared/isolated); others use two.

| Runtime/version | Platform | First observations | First resources | Second observations | Second resources |
| --- | --- | --- | --- | --- | --- |
| antigravity 1.4.4 | Linux-X64 | 7/7 | complete | 7/7 | complete |
| antigravity 1.4.4 | macOS-ARM64 | 6/7 | skipped | 7/7 | complete |
| antigravity 1.4.4 | Windows-X64 | 5/7 | skipped | 7/7 | complete |
| codex 0.165.0 | Linux-X64 | 9/9 | complete | 9/9 | complete |
| codex 0.165.0 | macOS-ARM64 | 8/9 | skipped | 9/9 | complete |
| codex 0.165.0 | Windows-X64 | Setup failed; no complete artifact | skipped | 9/9 | failed/partial |
| grok 1.0.70 | Linux-X64 | 7/7 | complete | 7/7 | complete |
| grok 1.0.70 | macOS-ARM64 | 6/7 | skipped | 7/7 | complete |
| grok 1.0.70 | Windows-X64 | Setup failed | skipped | 7/7 | complete |
| kimi 2.4.0 | Linux-X64 | 7/7 | complete | 7/7 | complete |
| kimi 2.4.0 | macOS-ARM64 | 6/7 | skipped | 7/7 | complete |
| kimi 2.4.0 | Windows-X64 | 6/7 | skipped | 7/7 | complete |
| opencode 2.2.1 | Linux-X64 | 7/7 | complete | 7/7 | complete |
| opencode 2.2.1 | macOS-ARM64 | 6/7 | skipped | 7/7 | complete |
| opencode 2.2.1 | Windows-X64 | 4/7 | skipped | 7/7 | complete |
| qoder 1.1.81 | Linux-X64 | 7/7 | complete | 7/7 | complete |
| qoder 1.1.81 | macOS-ARM64 | 6/7 | skipped | 7/7 | complete |
| qoder 1.1.81 | Windows-X64 | 6/7 | skipped | 7/7 | failed/partial |

First-run failures were canonical-directory spelling (all macOS runtimes,
Windows Kimi/OpenCode/Antigravity), PowerShell command invocation (Windows
OpenCode/Antigravity), setup deadlines (Windows Codex/Grok), and the selected
Qoder Windows crash target's identity. Windows OpenCode also failed to reach
the two-active-requests crash precondition. None supplies a passing observation
for that group; the corrected second run does.

## Resource comparisons

Each cohort opened ten sessions, ran one short scripted turn per session,
settled for five seconds, then took three five-second idle windows. Values
are **median (minimum to maximum)** across post-turn windows, six windows per
mode for Codex's repeated cohorts and three for others. Memory is MiB of the
whole native process tree (Windows working set, POSIX RSS). CPU is accumulated
process CPU time divided by elapsed wall time, as percent of one core.

Only intervals without exited processes support CPU comparisons. All complete
post-turn cells in the first two runs have that property. The follow-up below
explicitly excludes three Codex isolated windows from CPU comparison because
processes exited during them; their working-set readings remain usable. Initial `opened` windows are not
used; some include transient processes. Missing readings are never zeroes.

### First run: Linux x64 baseline

| Runtime | Isolated MiB | Shared MiB | Isolated CPU % | Shared CPU % |
| --- | --- | --- | --- | --- |
| antigravity | 4894.34 (4894.34 to 4897.82) | 1989.00 (1989.00 to 1990.64) | 1.79 (0.80 to 1.80) | 0.20 (0.20 to 0.20) |
| codex | 1954.93 (1952.96 to 1956.37) | 221.74 (221.15 to 223.74) | 0.30 (0.20 to 0.40) | 0.00 (0.00 to 0.20) |
| grok | 1331.29 (1331.29 to 1331.29) | 164.11 (164.11 to 164.11) | 0.40 (0.20 to 0.60) | 0.00 (0.00 to 0.40) |
| kimi | 3348.57 (3344.70 to 3348.82) | 376.00 (376.00 to 504.10) | 5.59 (5.59 to 70.24) | 1.00 (1.00 to 15.57) |
| opencode | 3547.71 (3540.64 to 3561.81) | 384.88 (384.28 to 421.36) | 7.78 (7.39 to 13.97) | 1.00 (0.80 to 4.19) |
| qoder | 4769.50 (4746.04 to 5367.62) | 459.25 (458.55 to 460.07) | 73.47 (65.66 to 91.18) | 5.19 (3.00 to 10.98) |

### Second run: all measured platforms

| Runtime | Platform | Isolated MiB | Shared MiB | Isolated CPU % | Shared CPU % |
| --- | --- | --- | --- | --- | --- |
| antigravity | Linux-X64 | 4688.69 (4688.57 to 4689.83) | 2004.73 (2004.73 to 2006.31) | 1.99 (0.60 to 2.00) | 0.20 (0.20 to 0.40) |
| antigravity | macOS-ARM64 | 3466.39 (3466.39 to 3466.41) | 1899.38 (1899.38 to 1899.38) | 0.59 (0.40 to 0.60) | 0.20 (0.00 to 0.40) |
| antigravity | Windows-X64 | 3222.58 (3220.79 to 3223.02) | 1458.98 (1458.62 to 1459.19) | 0.00 (0.00 to 0.78) | 0.00 (0.00 to 0.26) |
| codex | Linux-X64 | 1952.32 (1951.52 to 1953.01) | 222.75 (221.13 to 224.34) | 0.30 (0.00 to 1.00) | 0.00 (0.00 to 0.20) |
| codex | macOS-ARM64 | 1398.50 (1397.94 to 1398.75) | 161.61 (161.55 to 161.69) | 0.79 (0.00 to 1.39) | 0.20 (0.00 to 0.20) |
| codex | Windows-X64 | missing | 136.69 (136.65 to 169.84) | missing | 0.00 (0.00 to 39.01) |
| grok | Linux-X64 | 1329.17 (1329.17 to 1329.17) | 164.61 (164.61 to 164.61) | 0.60 (0.20 to 1.40) | 0.40 (0.00 to 0.40) |
| grok | macOS-ARM64 | 874.83 (874.81 to 875.27) | 124.00 (124.00 to 124.00) | 0.99 (0.99 to 1.79) | 0.20 (0.20 to 0.38) |
| grok | Windows-X64 | 1098.18 (1088.46 to 1101.91) | 132.61 (132.01 to 133.50) | 0.81 (0.27 to 1.35) | 0.54 (0.27 to 0.55) |
| kimi | Linux-X64 | 3351.82 (3351.34 to 3356.70) | 381.77 (380.39 to 381.77) | 9.38 (3.99 to 73.07) | 0.60 (0.20 to 13.57) |
| kimi | macOS-ARM64 | 2719.44 (2718.52 to 2722.33) | 431.44 (426.31 to 558.14) | 28.29 (27.14 to 38.31) | 7.92 (1.77 to 9.43) |
| kimi | Windows-X64 | 2744.07 (2741.88 to 2752.66) | 291.88 (291.69 to 292.01) | 16.91 (12.15 to 28.36) | 2.19 (1.49 to 7.99) |
| opencode | Linux-X64 | 3557.18 (3548.12 to 3560.96) | 386.74 (386.35 to 422.69) | 8.78 (7.59 to 9.58) | 0.80 (0.80 to 4.59) |
| opencode | macOS-ARM64 | 3736.70 (3706.44 to 3822.02) | 470.92 (470.83 to 471.06) | 14.43 (12.42 to 30.21) | 1.58 (1.39 to 3.37) |
| opencode | Windows-X64 | 3667.72 (3665.39 to 3671.65) | 375.23 (374.49 to 377.25) | 9.38 (9.10 to 16.54) | 1.11 (0.28 to 2.49) |
| qoder | Linux-X64 | 5041.92 (5011.57 to 5053.31) | 457.61 (455.75 to 458.91) | 59.26 (43.10 to 63.89) | 8.59 (2.39 to 10.39) |
| qoder | macOS-ARM64 | 2584.97 (2534.64 to 2632.31) | 536.81 (532.73 to 917.22) | 88.84 (74.01 to 94.20) | 9.11 (6.55 to 13.26) |
| qoder | Windows-X64 | missing | missing | missing | missing |

The complete pairs have lower shared median memory and no higher shared
median idle CPU. These short runs establish the scoped gate decision above,
not a statistical guarantee for every interval or active workload. Antigravity
retains per-session helper processes, so its savings are smaller. macOS Qoder
and Kimi have visibly varying early post-turn memory; no stability claim is
made. The single completed Codex Windows shared cohort is retained as partial
evidence only: its isolated comparison and other shared cohort failed.

## Windows resource follow-up

Run 41063229973 kept Codex 0.165.0 and Qoder 1.1.81 and reran only their
Windows x64 resources after the probe correction in PR #546. It did not
rerun native observation groups or verify any newer runtime version.

| Runtime | Completed cohorts | Isolated MiB | Shared MiB | Isolated CPU % | Shared CPU % |
| --- | --- | --- | --- | --- | --- |
| codex | 4/4, six windows per mode | 1209.33 (1173.81 to 1223.66) | 138.19 (137.48 to 169.57) | 19.31 (8.58 to 34.66), 3 valid windows | 11.26 (0.00 to 30.64), 6 valid windows |
| qoder | 1/2, three isolated windows | 4878.98 (4865.22 to 4887.72) | missing | 124.62 (119.51 to 130.23), 3 valid windows | missing |

Codex's shared median working set is about 89% lower. Its shared median CPU
is lower when compared only with isolated windows that have no exited
processes. This completes the scoped Codex Windows resource gate together
with the second run's 9/9 native observation groups. It does not promise that
every shared CPU sample is lower than every isolated sample.

The selected post-turn windows are retained here so the CPU exclusions and
medians remain reviewable after the uploaded artifacts expire. CPU values in
rows with exited processes are lower bounds and are excluded from the CPU
comparison above. Memory uses every listed window.

| Runtime/cohort | Window | Working set MiB | CPU % | Processes exited during window |
| --- | --- | --- | --- | --- |
| codex 1 isolated | 1 | 1211.05 | 27.18 | 3 |
| codex 1 isolated | 2 | 1223.66 | 47.72 | 4 |
| codex 1 isolated | 3 | 1207.61 | 34.66 | 0 |
| codex 2 shared | 1 | 138.25 | 28.07 | 0 |
| codex 2 shared | 2 | 138.14 | 0.00 | 0 |
| codex 2 shared | 3 | 138.23 | 0.00 | 0 |
| codex 3 shared | 1 | 169.57 | 30.64 | 0 |
| codex 3 shared | 2 | 137.48 | 22.53 | 0 |
| codex 3 shared | 3 | 137.48 | 0.00 | 0 |
| codex 4 isolated | 1 | 1176.94 | 8.58 | 0 |
| codex 4 isolated | 2 | 1216.64 | 19.31 | 0 |
| codex 4 isolated | 3 | 1173.81 | 23.79 | 3 |
| qoder 1 isolated | 1 | 4887.72 | 124.62 | 0 |
| qoder 1 isolated | 2 | 4878.98 | 119.51 | 0 |
| qoder 1 isolated | 3 | 4865.22 | 130.23 | 0 |

Qoder's shared measurement failed before producing a resource window. Its
product process-table read took 5277 ms and returned an empty table missing
the probe host. The independent immediate CIM observation then took 5483 ms
and reported `ETIMEDOUT`, `SIGTERM`, and zero stdout/stderr bytes. This proves
that the follow-up query exceeded the existing five-second deadline. It does
not recover the suppressed first exception or prove whether CPU load, CIM
execution, or PowerShell startup caused that deadline to be exceeded.
Qoder Windows therefore remains a missing resource comparison, not a passing
result inferred from the other platforms.

## Windows resource gaps and cleanup boundary

The second run's Windows Codex isolated cohorts and one shared cohort, and
Qoder isolated cohort, failed when `Get-Process -Id` returned nonzero after
one requested PID disappeared. Other valid rows were discarded by the probe.
Qoder's shared cohort separately failed because product `readProcessTable()`
did not include the live probe host. That function catches PowerShell errors,
its five-second deadline and JSON parsing errors into an empty map; the saved
failure does not reveal which occurred. It does not prove high load caused it.

The [follow-up probe](https://github.com/botiverse/oar/pull/546) enumerates processes before selecting PIDs, retains an
empty-array result for exited PIDs, and still rejects real read errors. A
missing host still fails the measurement. An additional CIM observation keeps
status, signal, error code, elapsed time and structural counts, without raw
process data. This separate observation cannot retroactively identify the
original failure. The completed Codex follow-up above now fills that gap;
Qoder still requires a complete isolated/shared comparison after the query
failure has been investigated.

This is also a product cleanup concern, tracked separately before Phase 2:
an empty process table cannot distinguish unreadable descendants from none.
The shutdown path must not claim descendants were reclaimed without evidence.
Windows public `Session.resources()` currently returns null; the Windows
numbers in this report are experiment readings, not public API output.

## Admission limits and next work

- Admit only the exact runtime version and measured platform/architecture.
  Updating a binary does not inherit an earlier version's evidence.
- Loaded Codex resume can retain the old model while subscribed. A future
  adapter must reject duplicate live owners and handle idle unsubscribe,
  reload and actual model confirmation explicitly. It must not archive threads.
- Child ownership requires a native explicit relation, including Kimi's
  parent tool result, Grok's child ID relation and OpenCode's parent metadata.
  Unrelated or not-yet-associated frames must not be assigned by timing or
  whichever root session happens to be active.
- Native cancel/close alone leaves Grok's host-owned ACP terminals running;
  per-session terminal disposal is part of the required implementation.
- Fixture cleanup after an injected crash is separate from native cleanup.
  A shared-process crash affects all attached sessions; a released session
  cannot be advertised as a guaranteed stop of every native future action.
- OpenCode's cold database startup race remains an independent known limit.
  Wider manual probe deadlines do not change product startup guarantees.
- First implementation proposal is ACP connection sharing for the four
  admitted versions, with explicit refusal elsewhere. Codex and Qoder follow
  separately. Current hosts that force isolated placement keep that behavior.
  No sharing is enabled by this report.
