# Windows Pi RPC vendor cancellation observations

Runtime version check: 2026-10-30. Pi 1.4.0; Windows hosted CI.

## Result and scope

Among 101 completed routine attempts of the standalone `pi-rpc-windows
(vendor)` job, ten reached GitHub's job limit: **10/101, 9.9%**. Pull-request
attempts alone were **8/69, 11.6%**. These are observed job-limit cancellations,
not ten identified test hangs or proof that a VM failed.

The cohort is all 148 `ci.yml` workflows created from 2026-10-28T00:00:00Z
through 2026-10-30T15:55:00Z. The paginated jobs API was read with `filter=all`,
so a failed attempt and its successful retry both count. The immutable
[job rows](jobs-2026-10-30.csv) identify 108 distinct job IDs; the
[workflow inventory](runs-2026-10-30.csv) also retains workflows without this
job. There are no standalone vendor jobs on October 28 in this cohort;
earlier combined behavior/vendor jobs are outside this denominator.

| Job start date (UTC) | Routine success | Routine failure | Job-limit cancellation | Administrative cancellation | In progress |
| --- | ---: | ---: | ---: | ---: | ---: |
| October 28 | 0 | 0 | 0 | 0 | 0 |
| October 29 | 50 | 0 | 5 | 0 | 0 |
| October 30 | 36 | 5 | 5 | 1 | 1 |
| Total | 86 | 5 | 10 | 1 | 1 |

Routine means `push` or `pull_request`. Exclude the one explicit administrative
cancellation and one still-running job from the completed denominator. Do not
count a skipped step merely because the API assigns it a `started_at` value.
The five separate `workflow_dispatch` reproduction attempts are also excluded:
four succeeded and one failed. No job attempt is deduplicated by commit or run
ID. Repeated attempts are not independent experiments, and this changing-code
cohort is not a stable estimate of a runtime's inherent failure probability.

Routine successful jobs took 130 to 228 seconds, median 202 seconds. The ten
job-limit cancellations took 1500 or 1501 seconds, despite the configured
20-minute job limit and 12-minute vendor-step limit. Their only failure
annotation reports the job limit. In all ten, the last reported vendor step
remains `in_progress` with no completion timestamp. The API identifies only
that whole-suite step, so these samples cannot establish a common test file.

## Job-limit samples

Every time below is UTC. The linked job, its attempt, head SHA and exact
annotation are retained in the CSV. Later administrative cancellation of the
rest of a workflow does not reclassify an earlier vendor job-limit event.

| Run/job | Event | Job started | Vendor step started | Job completed |
| --- | --- | --- | --- | --- |
| [40897308775/123529826431](https://github.com/botiverse/oar/actions/runs/40897308775/job/123529826431) | pull_request | 2026-10-29T15:01:26Z | 2026-10-29T15:01:50Z | 2026-10-29T15:26:27Z |
| [40903813794/123552986603](https://github.com/botiverse/oar/actions/runs/40903813794/job/123552986603) | push | 2026-10-29T15:39:44Z | 2026-10-29T15:40:18Z | 2026-10-29T16:04:44Z |
| [40909552819/123573476832](https://github.com/botiverse/oar/actions/runs/40909552819/job/123573476832) | push | 2026-10-29T16:14:17Z | 2026-10-29T16:14:58Z | 2026-10-29T16:39:17Z |
| [40920869530/123613405532](https://github.com/botiverse/oar/actions/runs/40920869530/job/123613405532) | pull_request | 2026-10-29T17:23:36Z | 2026-10-29T17:24:10Z | 2026-10-29T17:48:36Z |
| [40933463254/123657706800](https://github.com/botiverse/oar/actions/runs/40933463254/job/123657706800) | pull_request | 2026-10-29T18:43:22Z | 2026-10-29T18:43:54Z | 2026-10-29T19:08:22Z |
| [40979204528/123814710791](https://github.com/botiverse/oar/actions/runs/40979204528/job/123814710791) | pull_request | 2026-10-30T00:21:50Z | 2026-10-30T00:22:18Z | 2026-10-30T00:46:50Z |
| [40990949951/123852947404](https://github.com/botiverse/oar/actions/runs/40990949951/job/123852947404) | pull_request | 2026-10-30T02:18:56Z | 2026-10-30T02:19:26Z | 2026-10-30T02:43:56Z |
| [40999893324/123881590005](https://github.com/botiverse/oar/actions/runs/40999893324/job/123881590005) | pull_request | 2026-10-30T03:54:02Z | 2026-10-30T03:54:32Z | 2026-10-30T04:19:03Z |
| [41062439418/124085269431](https://github.com/botiverse/oar/actions/runs/41062439418/job/124085269431) | pull_request | 2026-10-30T13:20:40Z | 2026-10-30T13:21:14Z | 2026-10-30T13:45:41Z |
| [41080042907/124146406343](https://github.com/botiverse/oar/actions/runs/41080042907/job/124146406343) | pull_request | 2026-10-30T15:22:07Z | 2026-10-30T15:22:40Z | 2026-10-30T15:47:07Z |

The last sample, run 41080042907/job 124146406343 on `9b198ab`, already
contains the bounded termination change from PR #553. Its job log returned
404 while the workflow was still pending, and no Windows vendor artifact was
available. Neither fact establishes whether the timeout handler ran, whether
logging blocked, or whether the VM lost communication. The final log fetch
remains a follow-up after the workflow completes. A static inspection also
finds synchronous sampling and writes before deadline checks; no available
sample locates the cancellation inside one of those operations.

## Follow-up and decision

Keep this job in pull-request CI and require all checks to pass. Split the
vendor suite into four sequential, named steps on the same Windows VM:
RPC-specific files, native Pi files, MCP files, and all remaining shared files.
The partition covers future vendor files as well. Each group keeps the
existing Vitest settings and three-minute external case ceiling, uses a
five-minute command ceiling inside a six-minute step, and writes separate
resource and diagnostic files. The overall job limit remains 20 minutes.
An ordinary failure allows subsequent groups to run, while the job stays red.
No test assertion, runtime request timeout, or required check is removed.

The jobs API can then identify the last reported group even when its logs are
unavailable. This still does not identify an individual case or establish a
cause. Grouping also changes cross-file scheduling, so a later pass cannot be
called a causal fix for the previous cancellations.

Cindy's October 30 decision: retain the PR gate and rerun only this job after
a job-limit cancellation. Reassess after **three post-split cancellations or
on November 6, whichever comes first**. If they concentrate in one group,
investigate that group; if dispersed and unexplained, consider moving the job
to a main-push observation workflow. That move requires the later decision and
is not part of this change. Task #97 tracks the count and the review date.

Local verification of the partition collected exactly the same 85 enabled
Pi RPC cases as the original full-suite command, with all 77 vendor files
selected once. The four groups passed 25/34/6/20 cases respectively, for 85
passed and 248 skipped. These are Linux native Pi results; Windows execution
of the four workflow steps still needs this PR's CI. The initial local project
fixture run inherited the embedding host's `PI_PACKAGE_DIR`; removing that
host-only environment value restored the pinned 1.4.0 executable metadata.
The RPC group had already passed; no assertion was changed.

## Repeat the inventory

Requires Python 3 and an authenticated, read-only-capable `gh` CLI. Write into
a new directory; partial/API failures abort instead of publishing a partial
count. The collector also retains full step metadata for later grouped runs.
It never dispatches, cancels or reruns workflows.

```sh
python3 experiments/windows-pi-vendor-ci/collect.py \
  --since 2026-10-28T00:00:00Z --until 2026-10-30T15:55:00Z \
  --out oar-trial-run/pi-vendor-ci
```

Workflow creation time defines the cohort; job outcomes are observations at
retrieval time, not a historical time-travel query. Later reruns or cancellations
can therefore change a repeated inventory. Preserve the dated CSV snapshot
instead of overwriting it.
