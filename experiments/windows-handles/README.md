# Windows output handles and bounded termination probe

Task #97 investigation only. No product code or normal CI monitor changes.
The branch replaces `ci.yml` with a manual-only Windows job; do not merge
that workflow. It uses synthetic Node children, no runtime account or key.

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
The prototype is not yet a regression against `windows-resources.ps1`.

Run the branch's `ci.yml` through `workflow_dispatch`. The job needs only
Node 24 and the runner's PowerShell, with no dependency installation. The
local package import resolves the shared TypeScript helper for Node's
built-in type stripping and for the repository type checker.

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

No Windows result yet. Retain `oar-trial-run/windows-handles` and the entire
workflow log before choosing a monitor change. A missing log or artifact
does not establish VM failure, resource exhaustion or a blocked kill.
