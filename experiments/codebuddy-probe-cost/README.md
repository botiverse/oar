# CodeBuddy installation probe cost under local load

Runtime version check: 2026-10-31

The local all-backend runner started 14 suites at once on a Linux x64 host
with 16 available logical CPUs. CodeBuddy 2.178.1 reached its unchanged
15-second `--help` deadline while its root was still runnable and accumulating
CPU time. This is evidence of local overload, not an exited root with output
pipes held by descendants. The action is to limit the local test runner;
product installation probing and its deadline are unchanged. CI runs each
backend in a separate VM and needs no scheduling change.

## Observations

The first failures on the adapter branch and exact main `e565d5f` used a
PATH-discovered CodeBuddy 2.173.0. Those failures alone do not say anything
about the pinned version. The observed 14-suite run below explicitly selected
CI's 2.178.1 through `OAR_CODEBUDDY_BIN` on main `e565d5f` and reproduced the
failure. The remaining 13 backends passed.

[Selected observations](observations.json) retain 22 direct help runs, two
version queries, all root samples and the concurrent suite's host samples.
`CLK_TCK` was 100 and page size was 4096 bytes. CPU time is accumulated across
native threads, so it can exceed elapsed wall time. The CPU figures below
are the largest sampled root counters, lower bounds rather than terminal
process accounting.

| Native version | Direct cohort | Runs | Exit wall time | Observed CPU time |
|---|---|---:|---:|---:|
| 2.173.0 | serial | 3 | 2.27-2.44 s | 3.12-3.13 s |
| 2.178.1 | serial | 3 | 2.25-2.32 s | 2.72-3.25 s |
| 2.173.0 | four concurrent | 4 | 2.42-2.48 s | 3.08-3.32 s |
| 2.178.1 | four concurrent | 4 | 2.59-2.60 s | 3.22-3.47 s |
| 2.173.0 | eight mixed, four of each version | 4 | 2.59-2.62 s | 2.62-3.13 s |
| 2.178.1 | eight mixed, four of each version | 4 | 2.48-2.61 s | 2.28-3.19 s |

All 22 direct help commands exited zero with no observed residual process.
The two version queries exited zero at about 1.70 s and confirmed the native
versions. A focused 2.178.1 behavior run also passed all 16 cases with three
capability skips.

The loaded run `run-2026-10-31T03-34-45.374Z` recorded:

- Timeout observation at 15,015.9 ms: `exit: null`,
  `closeObserved: false`, empty stderr. This is the executor's observation
  before timeout termination, not a conclusion inferred from process sampling.
- Fifteen samples of the same root identity all had state `R` (runnable).
  Observed CPU rose from 0.13 to 4.78 s over a 14.91 s observation span;
  the final sample had 33 threads. The process was making CPU progress.
- The one-minute host load ranged from 5.97 to 29.16 while the root was
  observed, and the suite tree grew from 68 to 141 processes.
- The observer was also delayed: median table/command scan 712 ms, maximum
  1,830 ms, median gap between root samples 962 ms despite a requested
  250 ms interval. State observations are snapshots, not proof that every
  intervening instant was runnable. Load average alone is not CPU utilization.

The diagnosis is local resource contention during the broad native run. The
measurements do not identify an internal CodeBuddy function or establish
that every probe timeout has this cause. The direct benchmark was not an
otherwise idle-machine experiment: a local repository check overlapped part
of it. No further load experiment was requested after this diagnosis.

## Local runner change

`sea-trial/all.ts` now admits at most
`max(1, min(4, floor(availableParallelism() / 2)))` simultaneous backends.
Native CLIs create their own threads and child processes, so a backend is not
a single CPU. All requested backends still run, including after another
backend returns a failure; output and report ordering remain the requested
ordering. Individual test concurrency, assertions and timeouts are unchanged.

The bounded run `run-2026-10-31T03-40-52.532Z` used the same pinned 2.178.1
executable and passed all 14 backends, including CodeBuddy installation and
all 16 supported behavior cases. This change does not claim that four
backends can never overload a machine already busy with other work.

## Reproduce the observations

The retained scripts require Linux and Node 24. They do not prompt a real
model or read credentials into the output. The suite uses its normal local
provider fixtures. Each output directory retains the original observations;
CLI content is discarded by the direct probe except for a version-shaped
string from `--version`.

```sh
node experiments/codebuddy-probe-cost/direct.mjs /tmp/codebuddy-direct /absolute/first/codebuddy /absolute/second/codebuddy
CODEBUDDY_PROBE_VERSION=2.178.1 node experiments/codebuddy-probe-cost/observe-suite.mjs /absolute/oar-checkout /absolute/codebuddy /tmp/codebuddy-suite
```

Use a checkout of `e565d5f` as the second command's repository to reproduce
the original 14-way launch. Current main uses the bounded runner. These
scripts preserve the original sampling method, including its overhead; they
are diagnostic tools, not precise CPU profilers. Local executable paths were
parameterized for publication. In the selected data, `discovered-local`
corresponds to the first direct binary (2.173.0), and `pinned-2.178.1` to the
second. There is no reason to keep testing 2.173.0 outside this historical
comparison.

## Deferred observation

Periodic installation checks may spend several CPU seconds on `--help`.
A later investigation can compare a lighter native entry such as `--version`,
but only if it preserves all information the installation contract requires.
The current experiment does not change that contract or select a replacement.
