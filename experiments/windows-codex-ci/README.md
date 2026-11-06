# Windows Codex worker comparison

The first round is complete: [results and failure timeline](results.md),
[all nine selected samples](results.json). Eight jobs passed; one single-worker
job timed out during directory removal after native completion and exit.
Keep regular CI worker settings unchanged on this evidence. The temporary
workflow and shared fixture hooks have been removed.

The November 6 CI audit found both reproducible fixture errors and unexplained
startup/wait delays. Successful paired Windows Codex vendor steps took about
twice as long as Linux (27 pairs, median paired ratio 2.04). That observation
does not identify runner pressure or file concurrency as the cause.

The [latest failing Windows job](https://github.com/botiverse/oar/actions/runs/42219272509/job/127896958827)
timed out in four cases. In its retained rate-limit trace, preparation before
opening took 83.276 seconds; the correct native failure arrived at 118.762
seconds and native exit at 119.484, against the unchanged 120-second case
limit. Global preparation also took 16.223 seconds before test files started.
[Selected evidence](latest-codex-evidence.json) retains timestamps and the
original trace hash. It cannot locate the delay within preparation or identify
the last pending await. There were no CPU, memory, disk or worker measurements.

## Fixed first round

[The archived manual workflow](workflow.yml)
ran three independent Windows runners per group, nine jobs in total:

| Group | Vendor Vitest option | Replicas |
| --- | --- | --- |
| Current default | no `maxWorkers` override | 1, 2, 3 |
| Two file workers | `--maxWorkers 2` | 1, 2, 3 |
| One file worker | `--maxWorkers 1` | 1, 2, 3 |

The replica-first matrix interleaves groups in the submitted matrix. GitHub
controls actual scheduling; queue order and separate jobs do not establish
that virtual machines share hardware or load. There is no matrix concurrency
cap. Preserve the complete first attempt, including failures and missing data.
Do not substitute successful reruns into the nine slots.

The vendor step has a 60-minute limit and each job a 90-minute limit. A run
that reaches either limit remains that slot's result; retain its available
evidence without increasing the limit or rerunning it. Individual case limits
and assertions are unchanged.

Pins: Node 24.22.2, npm 11.19.1, pnpm 11.22.0, Codex 0.167.0, and the repository
lockfile (including Vitest 4.1.11). Actions use the revisions from the failing
job. The OS label is `windows-2025-vs2026`; GitHub still updates that image, so
its actual version, available CPUs and memory are recorded. Version checks
fail before measurement if a CLI differs. Compare image and resource cohorts
before interpreting differences.

Each job installs dependencies, runs the ordinary Codex behavior suite, then
runs the complete vendor directory with the same selection and base Vitest
configuration. Vendor measurement still runs after a behavior failure if the
version check passed, retaining that failure in the job. It does not run after
an installation/version failure. All cases, assertions, test/native timeouts
and snapshots are unchanged, including the single test that opens eight
sessions concurrently. `OAR_TEST_REQUIRE_AVAILABLE=1` makes missing Codex fail.
The worker setting applies only to vendor files, not behavior cases or sessions
inside a case. `ci.yml` and required checks are unchanged.

## Reproduce and collect

The recorded run is [42237872904, attempt 1](https://github.com/botiverse/oar/actions/runs/42237872904),
commit `9728c56988d524a061e0731dce7a8642c0a88ee6`. It was dispatched once;
no sample was replaced or rerun. The workflow is now an archive outside
`.github/workflows`, so ordinary CI cannot invoke it. No further round is
scheduled or needed for this report.

For historical reproduction, check out that exact commit in a separate
worktree. It contains the original fixture/warmup phase hooks and workflow.
The current scripts remain isolated under this experiment, but a local run
on the current tree has only the external observation hooks, not the removed
fixture/warmup markers. Do not compare those reduced phase sets as identical.

Download all nine `windows-codex-<group>-<replica>` artifacts, keeping each in a
separate directory. Also retain the run's job/step conclusions and durations:
installation failures can produce an artifact without `environment.json`.

```sh
python3 experiments/windows-codex-ci/analyze.py downloaded-artifacts > comparison.json
python3 experiments/windows-codex-ci/summarize.py downloaded-artifacts jobs.json artifacts.json > results.json
```

At the recorded commit, local validation used a disposable native environment:

```sh
CI=1 OAR_TEST=codex-aimock OAR_TEST_REQUIRE_AVAILABLE=1 \
  OAR_CODEX_WORKERS=2 OAR_CODEX_PHASES=/tmp/codex-comparison-run/codex-comparison \
  pnpm exec tsx experiments/windows-codex-ci/run.ts
```

Use a new output directory each time; an existing `environment.json` refuses
the run instead of mixing attempts. Optional positional paths select files for
local checks only. The Windows workflow passes none and runs the full suite.
Native calls use the existing local aimock provider, without a real account.

## What is recorded

- `environment.json` and `versions.json`: actual versions, image, CPUs/memory,
  run/attempt, commit, and hashes of the lockfile, base config, `ci.yml` and
  the eight-session regression file.
- `phases-<pid>.jsonl`: UTC and process-monotonic timestamps, file/test names,
  PID, worker/pool IDs, Vitest configuration/results, global process-table
  preparation, fixture mock/directory/config, warmup installation/launch/
  initialize/exit, installation lookup, session open, native turn boundaries,
  dispose/exited responses and fixture server/directory cleanup.
- `resources.jsonl`: Windows CPU percentage, available memory, disk latency,
  transfers and queue length; per-process PID, name, creation time, cumulative
  CPU, memory, handles and threads. Counter/process read failures are retained.
- Existing native traces and the process-table preparation report remain in
  `oar-trial-run`; upload runs even when a job fails.

The PowerShell sampler starts after Vitest launches, without waiting for its
first sample or making an extra CIM call. One counter read plus process
enumeration is followed by roughly five seconds of sleep. Slow sampling can
miss brief peaks; samples describe host observations, not native start times.
The ten-second sampler shutdown wait bounds only this diagnostic process,
not Vitest, native operations or test cleanup. Sampler failure does not change
the native test's exit code.

The experiment-only setup observes the original installation/session promises
and Session objects. It records no native payload, prompt, command arguments,
environment values or credentials. Logging adds synchronous file I/O and
promise observers to all three groups; these runs are not uninstrumented
performance baselines. Parent-process records survive a blocked test worker,
but a missing phase end alone does not prove that phase hung. Global setup
still invokes the original preparation exactly once.

`analyze.py` keeps missing slots, duplicate slots, malformed lines, unfinished
phases and test failures. Pool slots and file-worker PIDs are observed values;
unique PIDs are not simultaneous concurrency. File overlap intervals include
reporter delivery time. Resource distributions exclude invalid counter status.
Read raw timestamps alongside summaries; aggregating unlike cases can hide a
single very slow phase.

## Instrumentation validation before the round

Linux validation passed the full
check (3,627 tests and 18 mock behavior cases), all 77 Codex vendor checks with
observation enabled, and eight selected checks at each explicit worker setting.
All three controls include the unchanged eight-session case. Phase pairs and
worker/configuration records were inspected; the PowerShell script was parsed
on Linux, not executed against Windows counters. [Selected validation](validation.json)
states the local Node version (24.19.0) and scope. These results validate the
instrumentation and native behavior, not the Windows resource hypothesis.

Compare each runner's failures, full vendor duration, preparation/cleanup tail
latencies and resource samples. If lower file-worker counts help only the
parallel phase while global preparation remains slow, keep those mechanisms
separate. If all groups are slow, a worker limit is not an established remedy.
Nine green jobs cannot establish a root cause or a reliable failure-rate
change. Any proposal to change regular CI needs a separate result and review.

The temporary workflow is archived here, and the phase logger is now an
experiment helper. Shared `aimock.ts` and `codex-home.ts` are restored to their
pre-experiment contents. The scripts, selected evidence and conclusions remain
reviewable without leaving observation hooks in the regular test harness.

## DSH installation, separate finding

The audited Windows DSH install median was 625 seconds versus 26 on Linux.
In [successful job 127868894869](https://github.com/botiverse/oar/actions/runs/42210871353/job/127868894869),
`npm install` added 614 packages in about ten minutes. Restore found no npm
cache, and post-job save reported that neither configured path existed.
The configured paths at that audit point were `~/.npm` and
`~/AppData/Local/npm-cache`.
Thus this successful job did not populate the intended cache; no reinstall
experiment is needed to establish that defect.

The current official [Windows image installer](https://github.com/actions/runner-images/blob/main/images/windows/scripts/build/Install-NodeJS.ps1)
sets npm's cache to `C:\npm\cache`. The historical job did not print
`npm config get cache`, so its exact effective path is not asserted here.
Use that command's output for the cache action, as
[setup-node itself does](https://github.com/actions/setup-node/blob/v4/src/cache-utils.ts),
instead of hard-coding another path. Keep the download-only cache keys and
normal exact-version DSH installation. PR #669 subsequently applied this independent fix.
The first main runs saved caches, but both DSH restores preceded the first
save, so a warm main comparison is still pending. [Results](results.md#npm-cache-follow-up)
keep cache transfer and install time separate; no speedup is claimed.

A corrected tarball cache still leaves extraction and lifecycle scripts.
The retained log lacks package-level timings, so neither the expected savings
nor the cause of all ten minutes is known. The installed DSH 0.2.1-rc.5 CLI
[package](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.5) includes
many profile/plugin dependencies; changing its package manager or caching an
entire installation would change additional variables. There is no measured
basis here for a faster replacement installer. First restore the intended
npm cache, then use naturally arriving installation logs to assess its effect.
