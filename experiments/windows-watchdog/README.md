# Windows watchdog fixture readiness

The blocked-worker fixture must let the reporter persist its test name before
blocking the worker's event loop. Waiting 500 ms did not guarantee that handoff.
It now polls the actual `active-tests.json` entry, within the existing nested
test deadline. No reporter, monitor or product behavior changes.

## Windows failure

[Main CI job 128225418789](https://github.com/botiverse/oar/actions/runs/42315029165/job/128225418789),
attempt 1 at `418a69e9`, failed the named two-second deadline assertion. The
preserved diagnostics show the following sequence on 2026-11-06 (UTC):

| Time | Recorded fact |
| --- | --- |
| 23:57:36.309 | Launcher requested the probe. |
| 23:57:40.746 | PowerShell sampler entered. |
| 23:57:41.076 | Sampler launched the nested Vitest process. |
| 23:57:41.874 | Reporter recorded `run_start`. |
| 23:57:42.136 | Worker loaded the fixture. |
| 23:57:42.139 | Reporter recorded `module_collected`. |
| 23:57:42.144 | Worker entered the test. |
| 23:57:42.649 | Worker blocked after its 500 ms sleep. |
| 23:58:01.554 | Sampler reached the 20-second command ceiling. |
| 23:58:01.625 | Launcher returned exit 124. |

There is no `case_start` or diagnostic-write failure in the reporter log, and
the last active-case snapshot is `[]`. The sampler continued collecting
resources and terminated the root process; it could not name a case it had
never observed. This was a unit-test failure, before the CodeBuddy installation
step. It is separate from that installation's unresolved 180-second failures.

Raw evidence identifiers and SHA-256 digests:

- Job log: `d0d25b3a0b19a38b945c77acf1577223b14dec40f794d77a830cb001817e87a6`.
- Artifact `13551015744`, 24,199 bytes:
  `5d35d7449ce33735607738087d957d9abb4d484afeb5770ee6d6042286cb2a16`.

## Scheduling control

Vitest 4.1.11 batches worker task updates with a 100 ms timer in
`@vitest/runner`'s `sendTasksUpdateThrottled`. Starting the test queues a
`test-prepare` update; it does not wait for the parent's `onTestCaseReady`.
Blocking that worker before it sends the update can therefore prevent the
reporter from receiving the test name.

The [POSIX probe](readiness.py) uses the real installed Vitest and OAR reporter,
with a minimized copy of the blocked-worker fixture. It deliberately changes
100 ms timers to 750 ms, compares the old 500 ms sleep with the new snapshot
poll, and kills each probe's process group after four seconds. This control
shows that a fixed sleep is insufficient. It does **not** establish why the
update was delayed or absent in the original Windows run.

```sh
pnpm install
python3 experiments/windows-watchdog/readiness.py --output oar-trial-run/watchdog-readiness
```

The output directory must be new. Raw child output stays local; `selected.json`
omits machine paths. [Selected Linux results](selected.json) show the old
fixture blocking without a recorded case, and the revised fixture blocking
only after `case_start` and the active snapshot appeared. Both workers still
block until the experiment kills them.

The actual Windows regression remains the proof of named timeout and process
termination. It keeps the nested 1-second test limit, external 2-second case
limit, 20-second command ceiling, 35-second launcher limit and 45-second outer
test limit. The snapshot poll fails after 900 ms if readiness never arrives;
it does not manufacture a reporter event. All existing exit, test-name,
termination and worker-checkpoint assertions remain.

## Windows validation

PR #686's [Windows check](https://github.com/botiverse/oar/actions/runs/42318542225/job/128237161457)
passed all five diagnostic tests. Its retained blocked-worker trace records
`case_start` at 00:32:09.314 UTC on November 7, followed by `worker_blocking`
at 00:32:09.323. The sampler reported the named two-second `case_timeout`
at 00:32:11.731, then confirmed root exit and returned 124. It did not reach
the 20-second command fallback. Artifact `13552336852` is 11,441 bytes with
SHA-256 `2d6a98a8addb4cad9249f9c17845b90a7c43854e66b14ca84979433de23e94b3`;
the job log SHA-256 is
`913bdd7138479af43ab69686b16bbfc5dc19f73d614fa2157d2608f3a55711e6`.

This verifies the revised fixture on Windows without claiming the cause of
the original delayed or missing reporter update. The merged main check at
`929bd86e` also passed.
