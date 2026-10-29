# Windows Pi RPC duration comparison: 2026-10-29

Nine runner-loss jobs have GitHub start-to-completion durations of 46:00 to
48:01, while nine selected successful jobs took 2:33 to 4:02 (median 3:34).
Eight lost jobs last reported the vendor step active; one last reported shared
behavior. These are metadata timestamps, not proof of 46 minutes of CPU work
or runner liveness. No failed-run log or terminal resource sample was recovered.

## Lost jobs

| Job | Date UTC | GitHub duration | Last active stage |
| --- | --- | ---: | --- |
| [main after #465](https://github.com/botiverse/oar/actions/runs/40324749088/job/121578460726) | 2026-10-26 | 47:00 | vendor |
| [main after #477](https://github.com/botiverse/oar/actions/runs/40332163567/job/121604100950) | 2026-10-26 | 46:01 | vendor |
| [#488 first attempt](https://github.com/botiverse/oar/actions/runs/40333444058/job/121608579249) | 2026-10-26 | 46:01 | vendor |
| [main after #493](https://github.com/botiverse/oar/actions/runs/40359896785/job/121702185703) | 2026-10-26 | 47:01 | vendor |
| [main release 0.75.0](https://github.com/botiverse/oar/actions/runs/40495932395/job/122161246118) | 2026-10-27 | 48:01 | vendor |
| [#502 old head](https://github.com/botiverse/oar/actions/runs/40649785255/job/122686910944) | 2026-10-28 | 46:00 | vendor |
| [#505 old head](https://github.com/botiverse/oar/actions/runs/40649988326/job/122687558582) | 2026-10-28 | 47:01 | vendor |
| [#513 old head](https://github.com/botiverse/oar/actions/runs/40712178996/job/122900087726) | 2026-10-28 | 46:00 | shared behavior |
| [#514 first attempt](https://github.com/botiverse/oar/actions/runs/40798866545/job/123201861941) | 2026-10-29 | 47:01 | vendor |

The previous [resource report](windows-ci-2026-10-26.md) retains the source
annotations and sampled successful-run findings. In the eight vendor losses,
shared behavior completed normally in 26 to 42 seconds before that stage.
The first eight observations span main and PRs; the ninth is PR #514, head
`9c9777c`. Its unchanged rerun passed. The eighth was an old #513 head; its
current-head success is a comparator, not an unchanged rerun.

## Successful comparators

These are all five successful resource samples from October 26, plus the
previously recorded #488 rerun, the release 0.75.0 rerun, current #513, and
#514 rerun. They are an explicit convenience sample, not every job or an
estimate of the runner-loss rate. Versions and workloads changed over time.

| Job | GitHub duration | Shared behavior | Vendor |
| --- | ---: | ---: | ---: |
| [121634384018](https://github.com/botiverse/oar/actions/runs/40333444058/job/121634384018) | 3:37 | 0:30 | 2:30 |
| [121671680600](https://github.com/botiverse/oar/actions/runs/40351279822/job/121671680600) | 3:40 | 0:29 | 2:32 |
| [121677609367](https://github.com/botiverse/oar/actions/runs/40352938236/job/121677609367) | 3:34 | 0:28 | 2:29 |
| [121689342469](https://github.com/botiverse/oar/actions/runs/40356234924/job/121689342469) | 3:24 | 0:27 | 2:19 |
| [121691058554](https://github.com/botiverse/oar/actions/runs/40356722686/job/121691058554) | 3:31 | 0:27 | 2:24 |
| [121714186400](https://github.com/botiverse/oar/actions/runs/40363303349/job/121714186400) | 2:45 | 0:24 | 1:47 |
| [122181981360](https://github.com/botiverse/oar/actions/runs/40495932395/job/122181981360) | 2:33 | 0:23 | 1:41 |
| [122911500525](https://github.com/botiverse/oar/actions/runs/40715378986/job/122911500525) | 4:02 | 0:27 | 2:39 |
| [123217297319](https://github.com/botiverse/oar/actions/runs/40798866545/job/123217297319) | 3:44 | 0:26 | 2:39 |

## Interpretation and bounded experiment

The strong separation is in GitHub's reported duration and last known stage.
The near-uniform lost-job completion times may include a runner-loss detection
interval. Available metadata cannot distinguish a test hang, child-process
hang, runner agent failure, VM failure or the exact moment communication
stopped. Successful resource samples do not diagnose an unavailable failed VM.

The CI change splits Windows `pi-rpc-aimock` into independent `behavior` and
`vendor` jobs, with their original commands and resource sampler. This isolates
phase outcomes and artifacts. Other platforms still run the combined job.
No runtime code, assertion, test timeout or concurrency setting changes.

The vendor step now has a 12-minute CI ceiling and each Windows Pi RPC job
has a 20-minute ceiling. A live runner may terminate a hung step in time to
retain output and upload samples. A dead runner may still preserve nothing;
a timeout is diagnostic evidence, not a guarantee of logs or a fix. Upload
remains `always()` with separate phase artifact names. There is no external
reporting service, automatic retry or skipped suite.

After merge, compare the first three naturally occurring main runs of both
new jobs: outcome, duration, last active test step, sampler availability and
process/resource end state. Record new runner losses independently. A few
passes do not prove improvement; preserve the denominator before comparing
incidence with this unsystematic historical sample. A surviving timeout should
be investigated from its last test output and samples before changing tests.

## Reproduce

The [read-only collector](windows-ci-duration-audit.py) fetches job metadata
using the caller's Stamp identity. It reads no command logs or environments.
The [selected JSON](windows-ci-duration-2026-10-29.json) retains all 18 jobs'
URLs, timestamps and stage states used above. Example:

```sh
python3 experiments/windows-ci-duration-audit.py \
  --job 123201861941 --job 123217297319
```

Elapsed time is `completed_at - started_at` at job level. A stage with
`in_progress` and no completion remains unknown; it is never assigned the
job's completion as its own finish. Full API replies remain local artifacts.
