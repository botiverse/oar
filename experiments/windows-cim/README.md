# Windows process-table observations

This temporary investigation compares the current complete CIM query with
`Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate`
and measures a fresh `powershell.exe` with no process-table query. It follows two
Windows CI failures that reached the old reader's five-second limit and then
reported a missing child because that reader turns errors into an empty table.
The durations alone do not prove why the query failed.

Run `node experiments/windows-cim/observe.ts [output-directory]` on Windows.
The recorded runs used a temporary manual-only workflow on one Windows VM,
with read-only repository permissions and no runtime account. That workflow
is not part of this change. The loaded run had a ten-minute job limit;
the script retains its 480-second overall limit. It
prints samples as they arrive and keeps a partial report after every sample.
Only this probe's Node children and PowerShell processes are terminated.

Four samples reproduce the current query and five-second timeout. Measured
queries allow 15 seconds to observe completed durations beyond that threshold;
these are observations, not product deadline changes. Each query gets six
sequential and six paired samples in alternating order. Summaries report
successful samples separately from failures and retain every individual result.
The no-query baseline measures shell launch plus minimal execution and output,
not an exact subtraction that isolates every launch cost.

Visibility samples bracket each CIM query with `Get-Process` for the owned child.
They retain spawn-call and spawn-event timestamps, the child's native creation
time when available, query-start/end timestamps and both visibility results.
The first positive sample provides an upper bound on visibility after creation,
not the exact instant the process became visible. The two APIs are queried
sequentially, not atomically. A long CIM query can therefore explain a late
positive observation without implying a visibility delay. The script preserves
query-start markers even when the shell times out before producing a result.

The bounded paired load does not reproduce ten Qoder sessions or a full Vitest
run. A passing observation cannot disprove failures under those workloads.
No product deadline, reader, cleanup behavior or test assertion changes here.


The loaded phase starts one busy-loop Node process per available logical CPU,
with a cap of 16 and the actual core/worker counts recorded. Every worker must
report readiness; after two seconds of load, each query runs three times with
a 60-second observation limit and counterbalanced order. `Get-Process` CPU
counters for the owned workers bracket each query. They show the applied load,
not a claim that the original failure workload has been reproduced. Workers
must remain alive throughout the measurements and are stopped in `finally`;
each also self-expires after 450 seconds. The normal probe children outlive the
60-second query limit. Product deadlines and assertions are unchanged.

## Initial observations

[Run 41065624954](https://github.com/botiverse/oar/actions/runs/41065624954),
commit `2b1cf24350c4bc556751459be6212739f778713e`, completed all 36 unloaded
samples on Windows x64 with Node 24.22.1. Selected values and every individual
elapsed time are retained in [idle-41065624954.json](idle-41065624954.json).

| Scenario | Samples | Total ms, median (min to max) | Query ms, median (min to max) |
| --- | --- | --- | --- |
| Empty PowerShell | 4 | 197.71 (189.36 to 1817.70) | not measured |
| Original query with 5 s limit | 4 | 388.57 (362.84 to 1628.42) | not measured separately |
| Full properties, sequential | 6 | 394.23 (389.32 to 443.19) | 159.85 (157.17 to 163.32) |
| Three properties, sequential | 6 | 379.37 (370.43 to 385.90) | 143.37 (141.71 to 148.94) |
| Full properties, paired | 6 | 477.63 (464.51 to 496.48) | 183.46 (170.82 to 192.02) |
| Three properties, paired | 6 | 452.39 (442.12 to 467.81) | 161.18 (156.53 to 170.45) |

Four additional visibility observations found the child in the first CIM
result, with `Get-Process` seeing it both before and after that query. The
first `Get-Process` observation was 176 to 192 ms after native process
creation; CIM completion was 385 to 512 ms after creation. These are sampling
bounds, not measured appearance latency. No five-second timeout occurred.
The small projected-query gain on this runner does not establish a remedy
for the earlier CI failures. The loaded phase is a separate follow-up.

## Cold first commands and CPU load

[Run 41067396304](https://github.com/botiverse/oar/actions/runs/41067396304),
commit `0c9926fea8bb7458f84e07908d6e487c90665359`, completed on another Windows
x64 VM with Node 24.22.1. The observer completed successfully while retaining
one failed native sample among 42. All timings and the worker CPU counters are
in [loaded-41067396304.json](loaded-41067396304.json).

Before applying load, the first empty PowerShell command took 6818.64 ms.
Its exit event was observed at 6817.88 ms, so that sample was not delayed by
output pipes remaining open after exit. The next three empty commands took
260.48, 240.28 and 223.48 ms. The first exact CIM command then hit its 5000 ms
limit, returning after 5017.14 ms with SIGTERM and no stdout or stderr. The next
three exact commands passed in 1412.88, 403.59 and 392.53 ms. The failed command's
completed duration and internal phase are unknown. Four prior empty commands
were not sufficient to prevent this first CIM failure.

The loaded phase ran four busy Node workers on four logical CPUs. Their CPU
counter deltas correspond to approximately 3.03 to 3.48 busy cores during the
query intervals. Counter reads and timestamps are sequential, not atomic, so
these values describe approximate applied load, not exact machine utilization.
All six loaded queries found the observer's child and had empty stderr.

| Loaded query | Samples | Total ms, median (min to max) | Query ms, median (min to max) |
| --- | --- | --- | --- |
| Full properties | 3 | 997.58 (965.84 to 999.20) | 224.22 (178.98 to 229.92) |
| Three properties | 3 | 1060.02 (992.56 to 1383.21) | 207.23 (191.43 to 273.64) |

CPU load alone did not reproduce the five-second failure on this runner, and
requesting only three properties did not improve the whole-command duration.
The first empty command shows that delay outside CIM can exceed five seconds;
it does not identify which part of the later, terminated CIM command was slow.
Neither two VMs nor the earlier short startup study establish a universal
startup bound or explain the separate 25-minute Pi RPC job cancellations.

Windows tests and sharing probes now perform one bounded actual CIM read
before testing or measuring. This preparation records its duration and fails
explicitly if it cannot read the observer's creation identity. Its result is
not used as a later process-table sample, and a later failed measurement still
fails. Preparation reduces interference from first-use work; it does not
guarantee that later reads finish within the product's unchanged deadline.
Cold first-use observations remain this experiment's responsibility.
