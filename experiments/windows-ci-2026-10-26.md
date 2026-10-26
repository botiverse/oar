# Windows CI investigation: 2026-10-26

Three successful main Windows Pi RPC jobs showed no resource exhaustion or
Node processes left at the end of either test stage. Another main job lost
runner communication after the sampler was added, without retaining logs or
an artifact. The successful samples do not establish the cause of the lost
jobs. A runner infrastructure fault remains a hypothesis, not a finding.

| Run and job | Observation | Remaining uncertainty |
| --- | --- | --- |
| [main after #465, Pi RPC](https://github.com/botiverse/oar/actions/runs/40324749088/job/121578460726) | Lost runner communication; no failed step, retained log or Windows Pi RPC artifact. | Resource exhaustion, process cleanup and external failure remain unseparated. |
| [main after #477, Pi RPC](https://github.com/botiverse/oar/actions/runs/40332163567/job/121604100950) | The same runner-loss annotation; again no retained log or artifact. | Repeated in this backend, but the cause is unknown. |
| [#488 first Pi RPC job](https://github.com/botiverse/oar/actions/runs/40333444058/job/121608579249) | Lost runner communication; an unchanged rerun passed 19 shared cases and 78 native tests. | One passing rerun does not rule out a resource or cleanup problem. |
| [main after #493, Pi RPC](https://github.com/botiverse/oar/actions/runs/40359896785/job/121702185703) | Lost runner communication with the sampler installed; shared behavior passed, vendor tests were the last active step. No retained log or Windows Pi RPC artifact. | No terminal resource sample could be recovered, so the fourth loss still has no identified cause. |
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

### Successful main samples

The following three main jobs retained both sampler files. All six commands
exited 0, with no sampling error or sample limit reached. Each stage's first
and last samples contain zero Node processes. The machines reported 15.995 GiB
physical memory; the lowest observed free memory was 11.614 GiB, corresponding
to at most 4.381 GiB in use. These are sampled observations, not continuous
upper bounds.

| Main job | Stage | Samples | Minimum free GiB | Peak Node count | Peak Node working set / private GiB |
| --- | --- | ---: | ---: | ---: | ---: |
| [d9806e5](https://github.com/botiverse/oar/actions/runs/40356234924/job/121689342469) | Shared behavior | 7 | 11.866 | 18 | 1.918 / 2.143 |
| d9806e5 | Vendor | 30 | 12.043 | 10 | 1.109 / 1.362 |
| [e786679](https://github.com/botiverse/oar/actions/runs/40356722686/job/121691058554) | Shared behavior | 7 | 11.854 | 18 | 1.890 / 2.049 |
| e786679 | Vendor | 30 | 12.090 | 9 | 1.075 / 1.297 |
| [4339a32](https://github.com/botiverse/oar/actions/runs/40363303349/job/121714186400) | Shared behavior | 7 | 11.614 | 18 | 2.011 / 2.245 |
| 4339a32 | Vendor | 23 | 12.225 | 9 | 0.939 / 1.283 |

Node memory columns are the maximum, over the samples, of the sum of that
field for all `node.exe` processes in a sample. Working sets can share pages;
their sum is not unique physical memory use. System memory in use is computed
separately as total minus free physical memory. The longest recorded CIM query
in these main jobs took 531 ms. Five-second sampling can miss short-lived
processes and resource spikes.

For reproduction, download the `sea-trial-pi-rpc-aimock-windows-latest`
artifact from each linked run and read `windows-resources/behavior.jsonl`
and `windows-resources/vendor.jsonl`. Their artifact IDs, in table order,
are 12667000443, 12665868007 and 12668094072. Use only `kind: "sample"` rows
for resource extrema and the `stage_exit` row for each command's exit code.

Two earlier successful Pi RPC jobs on PR #492
([284ed50](https://github.com/botiverse/oar/actions/runs/40351279822/job/121671680600)
and [3204ad8](https://github.com/botiverse/oar/actions/runs/40352938236/job/121677609367))
also ended both stages at zero Node processes. Their lowest free memory was
11.807 GiB and peak Node count was 18. They are supporting pre-merge samples,
separate from the three main jobs above.

### Lost-run evidence boundary

The main e642251 job began its vendor step at 16:32:44 UTC. While the job was
reported as running, `stamp run view --job --log` reported logs unavailable
until completion, the job-log API returned BlobNotFound, and the live page
could not be retrieved from the investigation machines. GitHub marked the
job failed at 17:18:14 UTC with the runner-loss annotation. That timestamp
does not establish when the runner actually lost contact. After completion,
the log command reported that GitHub no longer retained the log, and no
Windows Pi RPC artifact appeared among the run's 20 artifacts.

The flushed checkpoints therefore did not preserve the failed runner's last
state through the available interfaces. The sampler can describe completed
jobs, including slow jobs that eventually finish; it cannot currently be
relied on to recover a lost runner's terminal state. No external reporting
service was added. This failed job was neither rerun nor canceled as part of
the investigation.

The bounded conclusion is: **successful runs showed no resource exhaustion
or surviving Node processes at stage end; the four runner-loss causes remain
unknown**. The data does not justify reducing concurrency or changing native
deadlines. Keep the sampler for subsequent evidence; an authorized unchanged
rerun may restore a failed CI check but would not explain its original failure.

For a fresh failure, compare samples across both stages for children surviving
their owner, rising private memory or sustained process counts. Check leaks
before lowering concurrency. The old runner-loss annotation alone is not
sufficient evidence for that change. No adapter retry, skipped behavior case,
weaker assertion or longer native timeout is introduced.

Sampling uses the documented Windows
[Get-CimInstance](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance)
API with a property allowlist.
