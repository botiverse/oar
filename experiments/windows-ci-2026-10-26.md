# Windows CI investigation: 2026-10-26

The available evidence separates runner loss from native startup deadlines.
It neither proves a functional Pi RPC regression nor clears its cleanup and
resource use. An unchanged rerun passing does not erase the original failure.

| Run and job | Observation | Remaining uncertainty |
| --- | --- | --- |
| [main after #465, Pi RPC](https://github.com/botiverse/oar/actions/runs/40324749088/job/121578460726) | Lost runner communication; no failed step, retained log or Windows Pi RPC artifact. | Resource exhaustion, process cleanup and external failure remain unseparated. |
| [main after #477, Pi RPC](https://github.com/botiverse/oar/actions/runs/40332163567/job/121604100950) | The same runner-loss annotation; again no retained log or artifact. | Repeated in this backend, but the cause is unknown. |
| [#488 first Pi RPC job](https://github.com/botiverse/oar/actions/runs/40333444058/job/121608579249) | Lost runner communication; an unchanged rerun passed 19 shared cases and 78 native tests. | One passing rerun does not rule out a resource or cleanup problem. |
| [main after #465, Qoder](https://github.com/botiverse/oar/actions/runs/40324749088/job/121578460583) | Two native tests reached the existing 60-second initialize deadline; six passed. | Startup failed before behavioral assertions, without runner loss. |

The Qoder failures were `next-priority steer preserves input identity at tool`
and `startup idle, consecutive prompts and current-open usage survive resume`.
The retained native logs show built-in plugin initialization lasting 51.961
and 35.894 seconds in two processes. Another records that phase starting at
12:49:37.302Z, without a completion in the retained log. The first process did
eventually log an initialize response. These observations locate slow work;
they do not explain why it was slow or reliably assign every log to a specific
failed test. Fixture cleanup also recorded home removal taking 19 to 31 seconds.

Release PR #489 separately hit Windows Codex effort and oversized-context
deadlines (180 and 120 seconds). The release owner handles its unchanged rerun;
this investigation does not launch a competing release run.

## Process and cleanup audit

Each matrix job has its own VM. Qoder cannot directly starve a Pi RPC job.
Qoder limits the shared behavior suite to two concurrent cases, but the later
Vitest command has three Qoder files and no equivalent worker cap. Its retained
logs show three native starts overlapping around 12:49:43Z. That distinction
belongs in the load investigation; it does not establish causation.
The shared Pi RPC suite can run
all 19 cases concurrently. Each session starts a Node version probe before
its main Node RPC child. Vendor tests run in a separate command afterward.

Pi RPC requests EOF shutdown. Windows cleanup snapshots the process table
while the child is alive, closes stdin and keeps the existing grace period.
It can query again for surviving descendants, using bounded PowerShell CIM
calls. Descendant cleanup checks PID and process creation identity; it does
not intentionally target the runner or an ancestor. Source inspection cannot
prove the absence of a live leak or a CPU/memory spike in the lost jobs.

## Evidence on subsequent runs

Only Windows Pi RPC CI commands use
[`sea-trial/windows-resources.ps1`](../sea-trial/windows-resources.ps1).
The wrapper retains the original commands, exit codes, output, concurrency
and test deadlines. One resident PowerShell process samples local CIM every
five seconds using bounded queries. Its added overhead is visible as query
duration in each sample. It records:

- total/free physical memory and process, Node and PowerShell counts;
- PID, parent PID, name and creation time;
- working set, private memory and cumulative CPU time per process.

It collects no command lines, executable paths or environment. JSONL records
are flushed immediately under `oar-trial-run/windows-resources/`, including
before/after each command, and small checkpoints enter the live job log.
The existing upload preserves partial samples if the runner survives. A lost
runner may prevent both log retention and upload; flushing cannot guarantee
recovery from a destroyed VM.

After 720 periodic samples, sampling stops without changing the command's
deadline. Sampling errors are separate records and never replace the command's
exit status. Windows unit tests run harmless commands exiting 0 and 37,
checking exit propagation, inherited output and sample contents. They skip on
non-Windows hosts; native sampler execution must be checked in Windows CI.

Collect several successful Windows runs after merge: report peak aggregate
working set and private memory, minimum free physical memory, peak Node count,
and whether counts fall after sessions end. These passing runs are the primary
source of resource evidence because a lost runner may retain nothing. Near-zero
free memory or continuously increasing counts would support the pressure/leak
hypothesis; passing assertions alone would not disprove it.

For a fresh failure, compare samples across both stages for children surviving
their owner, rising private memory or sustained process counts. Check leaks
before lowering concurrency. The old runner-loss annotation alone is not
sufficient evidence for that change. No adapter retry, skipped behavior case,
weaker assertion or longer native timeout is introduced.

Sampling uses the documented Windows
[Get-CimInstance](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance)
API with a property allowlist.
