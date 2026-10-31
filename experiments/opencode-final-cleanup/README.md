# OpenCode final cleanup observation

Runtime version check: 2026-10-31

The final lifecycle assertion must allow descendant exit to finish after
OAR has sent its cleanup signals. This change adjusts only the test observer
and clarifies the existing `exited` boundary. No product shutdown code changes.

## Original CI observation

[Run 41186300592, job 124493806298](https://github.com/botiverse/oar/actions/runs/41186300592/job/124493806298)
ran main `1be57a5cbc0979bbdc12be6dc08255b69cf877a9` on Linux x64 with
OpenCode 2.2.3. The auto lifecycle case failed during fixture reclamation;
the isolated control passed. Artifact `opencode-sharing-ubuntu-latest`,
ID `13036849515`, retains `opencode-sharing/auto.json`. Relevant fields are
copied into [selected.json](selected.json).

- Before disposing A, root 15817 owned standalone server 15827 and its two
  MCP servers, 15848 and 15854. The active tool and its child were also visible.
- Releasing A cleaned the active tool and child. B remained usable, and the
  subsequent directory and resume assertions passed.
- Releasing the last lease produced an exit record at 08:56:26.908 UTC.
  The root's exit code was 0, stderr was empty, and both `before_eof` and
  `after_exit` process-table observations succeeded without skipped entries.
- The final sample at 08:56:26.916, eight milliseconds later, still listed
  the standalone server and two MCP PIDs with the same creation identities.
  Their cwd and executable links were unavailable. Reclamation started at
  08:56:26.919. The later test-failure line is the reporting time, not the
  time those processes were observed.

That artifact did not retain Linux process states. It cannot distinguish
live processes, processes still exiting, and zombies. It does not prove a
live-process leak or prove a zombie-only false positive. A later green run
does not retroactively establish either explanation.

## Shutdown order

The audit uses product code at `3e47590f5063fc763774eb42a4e898503c7d3003`:

1. `process-pool.ts` retires the pool entry before calling its stop method.
2. `acp/shared-session.ts` closes the wire's bookkeeping and calls runtime
   kill. The SDK connection close cancels its reader; it does not close stdin.
   ACP's raw-byte drain keeps stdout open during shutdown.
3. `process-shutdown.ts` captures identities before closing stdin. Immediately
   before EOF and the native signal, it sets the stop-action marker.
4. Native exit waits for the active cleanup phase, then revalidates and
   signals remembered descendants before publishing `exited`.

The new real-process regression opens two shared leases. Its root owns a
standalone server and two MCP stand-ins in separate process groups. The first
lease release leaves them alive. A gate holds the final lease's real table
read; EOF has not arrived while that read is pending. Once released, the
root exits immediately on EOF and all three descendants are cleaned.
The EOF control runs on POSIX; Windows uses taskkill instead.

Removing only the stop-action marker immediately before EOF makes that
regression fail: all three descendants still exist after its five-second
check. Restoring the marker makes the regression pass. The temporary mutation
is not part of this change.

## Observer changes

The observer retains PID plus creation identity throughout a two-second
settling window. It sends no reclamation signals during that window.
Windows and macOS table queries retain their existing 60-second limits;
Linux reads procfs directly. The settling budget does not interrupt a table
read, and the evidence records actual elapsed time, including reads. Linux state and
creation identity come from the same `/proc/<pid>/stat` read. State changes
and final observations are retained in the artifact and job log.

Confirmed `Z` entries are recorded separately as zombies and receive no
signal. A different creation identity cannot inherit an earlier PID's
ownership. State-read errors remain failures. A non-zombie process still
present at the deadline is revalidated, reclaimed for fixture hygiene and
reported as a failed test. The observer does not wait indefinitely or turn
its own cleanup into a successful native result.

Regressions cover processes finishing during the window, live processes
surviving the deadline, zombies, PID reuse at final revalidation, and missing
or unreadable state. The product's `exited` record remains a statement that
cleanup actions finished, not a promise that the OS has reaped every child.

## Linux repeats and limits

Fifteen consecutive real OpenCode 2.2.3 auto lifecycle runs passed on a local
Linux x64 host using Node 24.19.0, the above product baseline, and this state
observer. Each used a fresh isolated HOME and the existing local scripted
provider. All fifteen final samples and reclamation observations were empty;
none needed the waiting window or observed a final zombie. Selected per-run
samples and native cleanup diagnostics are in [selected.json](selected.json).
The original CI condition was not reproduced, so these runs do not identify
its exact process states or establish a failure rate.

To repeat, put the exact 2.2.3 executable on PATH, then run from the repository:

```sh
opencode --version
for round in $(seq 1 15); do
  OAR_TEST=opencode-shared \
  OAR_TRIAL_RUN_DIR="$PWD/oar-trial-run/final-cleanup-$round" \
    pnpm vitest run sea-trial/vendor/opencode-sharing.vendor.test.ts \
      --maxWorkers 1 --testNamePattern 'OpenCode 2.2.3 auto:' || exit 1
done
```

Windows/macOS results for the revised observer belong to this change's CI.
The native lifecycle assertions, product deadlines and release CI gate are
unchanged.
