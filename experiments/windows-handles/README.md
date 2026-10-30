# Windows output handles and bounded termination probe

Task #97 investigation with synthetic Node children, no runtime account or
key. These manual probes are not part of the normal validation gate. The
investigation branch used a temporary manual-only workflow; that replacement
is not included here.

The first two cases deliberately leave a ready child alive as a workflow
step exits. One child inherits the step output handles; the other writes
to files. The following step records its start, the preceding wrapper's
exit boundary and descendant liveness before requesting fixture cleanup.
Every child also has a 45-second lifetime limit. The experiment records the
delay without assuming that inherited handles explain the earlier hang.

The other cases exercise a bounded-kill prototype with a normal native
kill and an injected operation that never returns. The target is ready and
alive first. After at most 10 seconds waiting for kill, the helper records
returned or unreturned termination and exits 124. The driver requires that
exit, the correct checkpoint and successful fixture cleanup. A helper exit
does not imply target exit: the injected case must leave its target alive.
The prototype records the original investigation independently of the
monitor. The permanent fault-injection regression exercises the monitor's
actual termination helper in `tests/windows-termination.test.ts`.

Use a disposable Windows runner with Node 24 and PowerShell, no dependency
installation. The [investigation workflow at 09bd47d](https://github.com/botiverse/oar/blob/09bd47d95866799f91c3b443bc1c30e7370f5126/.github/workflows/ci.yml)
is the exact step arrangement used for these results. For each `inherited`
and `file` case, run the wrapper in one workflow step, then the observer in
the following step, using the same unique output directory:

```powershell
pwsh -NoProfile -File experiments/windows-handles/step.ps1 -Mode inherited -OutputDirectory oar-trial-run/windows-handles/inherited
# This command belongs in a separate workflow step, not the same shell.
node experiments/windows-handles/fixture.ts observe oar-trial-run/windows-handles/inherited
```

Replace both `inherited` occurrences with `file` for the other case. Run
`node experiments/windows-handles/check-termination.ts oar-trial-run/windows-handles/termination`
for the two termination prototypes. The package import resolves the shared
TypeScript helper for Node's built-in type stripping and the repository
checker. Retain output with an always-running artifact upload step.

Local Linux validation used PowerShell 7.6.9 on .NET 10.0.14. Both output
fixtures reached their observation and cleanup steps. The normal kill
returned in 87 ms; the injected unreturned kill reached its checkpoint in
10,008 ms and the helper exited 124 in 11,089 ms including startup. The
normal target was gone, while the injected case left a live target that
then honored its stop file. These checks validate the fixture and prototype;
they do not measure GitHub's Windows step handling.

The [runner source at 110142c2](https://github.com/actions/runner/blob/110142c2c501c6ae9373d553efa826bedbaab5f7/src/Runner.Sdk/ProcessInvoker.cs)
waits five seconds for streams after observing process exit, then attempts
process-tree termination. This suggests distinguishing inherited-handle
delay from a blocked cleanup call; it does not identify the cause of the
earlier 25-minute cancellations. The actual runner version is retained in
the job setup log. Microsoft's
[WaitForExit documentation](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit)
also distinguishes process exit from completion of asynchronous output
processing.

## Windows observation, 2026-10-30

[Run 41029707952](https://github.com/botiverse/oar/actions/runs/41029707952)
used commit `eb598a0`, Windows runner 2.338.0, PowerShell 7.6.7, .NET
10.0.13 and Node 24.22.1. The observation and artifact upload steps ran.

| Case | Observation |
| --- | --- |
| Inherited output handles | Next step started 5663 ms after the wrapper's final record. The descendant was still alive and honored its stop file. |
| File output handles | Next step started after 397 ms. The descendant was still alive and honored its stop file. |
| Normal native kill | Kill returned in 10 ms; helper exit code 124; target gone. Total helper time including startup was 14,738 ms. |
| Injected unreturned kill | The helper wrote `termination_unreturned` after 10,016 ms and then a `stage_exit` 124 record. The collector failed its 25-second wait for Node's `close` event. |

The first two cases support a roughly five-second stream wait, not a
25-minute delay. The failed collector did not observe root exit separately,
so it cannot distinguish a surviving root from an exited root with open
pipes. A checkpoint announcing exit is not proof of actual process exit.
The current revision records `exit` and `close` independently and saves
output incrementally. It requires actual root exit 124 before target
cleanup, observes whether pipes remain open, then requires cleanup and
stream closure. The root's 25-second ceiling and the kill's 10-second
ceiling are unchanged.

[Node's event documentation](https://nodejs.org/api/child_process.html#event-close)
distinguishes `exit` from `close`: the latter also waits for the child's
stdio streams. Do not label the first run's collector failure a failure of
the bounded-kill operation without the separate exit observation.

Retain `oar-trial-run/windows-handles` and the entire workflow log. A missing
log or artifact does not establish VM failure, resource exhaustion or a
blocked kill. This probe has not established the cause of the earlier
Windows CI cancellations.

## Separate root exit and stream closure

[Run 41030609576](https://github.com/botiverse/oar/actions/runs/41030609576)
at `09bd47d` passed all cases on the same component versions. Inherited
handles delayed the next step by 5533 ms; file handles by 488 ms. Both
children were still alive, then stopped through their dedicated stop files.

Normal kill returned in 10 ms, the target was gone and the helper exited
124. The injected nonreturning kill reached its checkpoint after 10,005 ms;
the root actually exited 124 just 99 ms after its `stage_exit` record.
The target remained alive and the pipes remained open. After scoped target
cleanup, `close` arrived 1067 ms after root exit. The driver then confirmed
closed pipes. Both actual exit events and subsequent close events were
written incrementally, before the final summary.

This validates a bounded background termination path and demonstrates that
root exit can precede pipe closure. It does not establish why older jobs
were cancelled after 25 minutes, or explain rare CLI or certificate probe
timeouts. The monitor now uses a ten-second background termination wait and
preserves inherited output for live logs. A timeout skips the final resource
query and process disposal, so they cannot delay that exit path. A returned
Kill waits up to five seconds for root exit within that same total budget. A nonreturning or thrown
Kill still exits 124, leaving residual cleanup to the runner; successful
artifact upload is not guaranteed if the runner itself fails.
