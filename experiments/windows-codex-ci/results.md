# Windows Codex comparison: first-round results

Keep the regular CI worker setting. This round does not establish a smaller
worker count as a remedy for the intermittent Windows failures. All nine first
samples are retained: default and two-worker groups passed all three jobs;
the single-worker group had two passes and one timeout. Nothing was rerun.

[Run 42237872904, attempt 1](https://github.com/botiverse/oar/actions/runs/42237872904)
used commit `9728c56988d524a061e0731dce7a8642c0a88ee6` on November 6, 2026.
[Selected machine-readable evidence](results.json) includes job and artifact
identities, archive digests, cohort hashes, phase distributions, resource
samples and the failed case's timeline. [The original plan](README.md) and
[archived workflow](workflow.yml) preserve the exact scope.

## Nine independent runners

All jobs used image `win25-vs2026` version `20261103.298.1`, four available
logical CPUs and 17,174,360,064 bytes of memory. Node 24.22.2, npm 11.19.1,
pnpm 11.22.0, Codex 0.167.0 and Vitest 4.1.11 matched. Lockfile, base Vitest
configuration, normal CI and eight-session test hashes matched across all nine.
The observed pool slots and peak file intervals were 3, 2 and 1 respectively;
unique worker process counts are not simultaneous session counts.

Vendor wall time is measured from the wrapper's Vitest launch to its exit,
not the entire job or installation. CPU and phase medians are per runner.

| Group / replica | Result | Vendor seconds | Median CPU % | Fixture preparation median ms | Directory removal maximum ms |
| --- | --- | ---: | ---: | ---: | ---: |
| [default / 1](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960166047) | success | 344.888 | 92.38 | 2739.78 | 14302.33 |
| [default / 2](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960166170) | success | 265.150 | 80.07 | 2515.23 | 15455.72 |
| [default / 3](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165431) | success | 308.735 | 86.76 | 2585.72 | 16192.45 |
| [2 / 1](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165812) | success | 301.488 | 60.12 | 1683.93 | 3025.96 |
| [2 / 2](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165877) | success | 272.881 | 58.01 | 1608.60 | 8480.84 |
| [2 / 3](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165960) | success | 336.060 | 59.50 | 1936.98 | 19159.47 |
| [1 / 1](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165985) | failure | 611.553 | 32.99 | 1249.39 | 91471.87 |
| [1 / 2](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165996) | success | 617.532 | 40.63 | 1548.00 | 8379.56 |
| [1 / 3](https://github.com/botiverse/oar/actions/runs/42237872904/job/127960165943) | success | 612.992 | 41.26 | 1555.48 | 8461.77 |

The group medians were **308.735 seconds (default), 301.488 (two workers), and
612.992 (one worker)**. Default and two-worker durations overlap. Three samples
per group do not establish a reliable performance or failure-rate difference.
The smaller counts reduced sampled CPU and typical fixture preparation time,
but did not establish a suite-level improvement or remove cleanup outliers.
The one-worker group took about twice as long, including both passing samples.

The unchanged shared behavior step passed in all nine jobs.
Eight vendor runs passed all 71 enabled Windows checks. The failed run passed
70 and failed one; each run skipped the same 376 cases for other backends or
platforms. The unchanged test that initializes eight sessions concurrently
passed in every run. No runner slots, module ends or phase ends were missing;
there were no duplicate slots or malformed diagnostic lines. None reached the
60-minute step or 90-minute job limit. The resource sampler produced between
40 and 95 counter samples per job, roughly every 6.5 seconds, with no recorded
counter/process read errors. That sampling can miss brief peaks.

## The timeout occurred during cleanup

Single-worker replica 1 failed
`codex correlates native steer echo without a duplicate input` at 60.007 seconds.
The retained native frame reported completion, and the adapter then reported
process exit. Fixture directory removal remained pending past the test limit:

| UTC time | Observation |
| --- | --- |
| 15:01:17.266 | Case entered. |
| 15:01:18.708 | Fixture preparation finished, after 1.441 seconds. |
| 15:01:18.990 | Session open resolved, after 0.125 seconds. |
| 15:01:19.085 | Native turn started. |
| 15:01:20.008 | Native turn completed with outcome `completed`. |
| 15:01:20.699 | Adapter emitted `exited`. |
| 15:01:20.701 | Recursive fixture directory removal started. |
| 15:02:17.273 | Case hooks finished after Vitest's timeout. |
| 15:02:17.275 | The next case began fixture preparation in the same file. |
| 15:02:17.383 | Parent reporter recorded the failed test. |
| 15:02:18.335 | The next case began native warmup initialization. |
| 15:02:52.175 | The previous directory removal finished successfully, after **91.472 seconds**. |
| 15:03:00.925 | The next warmup finished, after 42.590 seconds; that case subsequently passed. |

The existing removal call uses `maxRetries: 10, retryDelay: 300`. The trace
records entry and eventual successful return; it does not record intermediate
filesystem errors, retry counts, remaining descendants or the lock owner.
Consequently it proves neither an `EBUSY` cause nor that a native child,
antivirus, disk service or runner pressure caused this delay. Process exit
observed by OAR is not proof that every descendant or file handle was gone.

During the 91-second removal window, 14 resource samples show median CPU
10.35% (maximum 13.35%), at least 12,249 MiB available memory, median disk
transfer latency 41.49 ms (maximum 66.53 ms), and disk queue length median 4
(maximum 12). These are machine-wide sampled counters, not attribution to the
removed directory or a process. They do not identify the cause.

The later warmup overlaps cleanup after Vitest timed out. Thus even one file
worker does not guarantee that asynchronous work from a timed-out case has
finished before the next case starts. The timeline establishes overlap, not
that it caused the next warmup's delay. The earlier audit's unlocated
83-second preparation delay is a separate observation, not retroactively
explained by this cleanup sample.

## Later ordinary CI observation, outside the nine samples

PR #670's [Windows Codex job](https://github.com/botiverse/oar/actions/runs/42239998607/job/127967452325)
subsequently timed out in both `codex-messages` variants (60 seconds each),
with 69 other checks passing. This is attempt 1 at `65452bd8`, a separate run
from the fixed comparison above. [Selected trace evidence](later-ci-evidence.json)
retains its source hashes and timestamps without changing the nine samples.

The first case submitted its prompt 58.280 seconds after entering. Its native
turn completed at 68.679 seconds and exited at 69.572 seconds. Those late
records are in the second case's trace file because `openTrace` changes the
shared output destination; they still carry the first session's identity and
continuing sequence numbers. They do not establish that the second case opened
or completed. There are no fixture/preparation subphases for this ordinary CI
job, so its internal delay and the second case's last pending operation remain
unknown. This is a reason to check record identity as well as trace filenames,
not evidence that the DSH change caused a Codex regression.

## Cleanup and validation

The temporary workflow has moved out of `.github/workflows`. Both shared
Codex fixture files are restored byte-for-byte to the pre-experiment commit
`6e7fe8b9`; the logger and its existing tests now refer only to the experiment
helper. Ordinary CI, product code, case assertions, case/native deadlines and
the eight-session test are unchanged.

The scripts, archived workflow and selected results remain here. Full
fixture/warmup instrumentation is reproducible by checking out the recorded
commit, as described in the README. Artifact digests identify the unchanged
first-round downloads; GitHub's archive retention is finite, so the selected
evidence is also committed. No further Windows round was started for cleanup.

Cleanup validation on Linux with Codex 0.167.0 and the local provider passed:
3,627 unit tests, 18 mock behavior cases, all 77 Codex vendor checks and
16 Codex behavior cases (3 unsupported cases skipped). The results selector
reproduced the committed JSON byte-for-byte. [Validation metadata](validation.json)
keeps these separate from the earlier instrumented controls and Windows round.

## npm cache follow-up

PR #669 separately corrected the npm cache path. All 15 platform/runtime PR
combinations saved a cache. PR caches are scoped to their merge ref, so main
needs its own first save. The first two naturally triggered main DSH jobs both
restored before that first save completed:

| Main run | Restore attempt UTC | Restore | Install seconds | Post-job save seconds | Save completed UTC |
| --- | --- | --- | ---: | ---: | --- |
| [42236050383](https://github.com/botiverse/oar/actions/runs/42236050383/job/127953811391) | 14:41:56 | Miss, 1 second | 807 | 24 | 14:59:23 |
| [42237027174](https://github.com/botiverse/oar/actions/runs/42237027174/job/127957197678) | 14:47:45 | Miss, under 1 second | 582 | 4 | 15:00:27 |

Both runs saved a roughly 163.5 MB DSH cache on main. The restore plus install
plus save totals were about 832 and 586 seconds, respectively; neither was a
warm-cache observation, so their difference cannot be credited to cache
restoration. A later natural main run is needed to measure a hit and its
combined transfer/install cost. No extra installation experiment or retry was
started. This outstanding measurement does not change the worker comparison.
