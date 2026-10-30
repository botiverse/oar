# Keep potentially blocking tree termination off the monitor's main thread.
# This helper is also invoked directly by the fault-injection regression.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading.Tasks;
public static class OarCommandTermination {
    public static Task Begin(Process process, Action<Process> terminate) {
        return Task.Run(() => {
            if (terminate == null) { process.Kill(true); }
            else { terminate(process); }
        });
    }
}
'@

function Exit-TimedOutCommand {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Child,
        [Parameter(Mandatory)][scriptblock]$Record,
        # The regression supplies a native delegate that never returns or throws.
        [System.Action[System.Diagnostics.Process]]$Terminate = $null
    )
    $targetId = $Child.Id
    & $Record @{ kind = 'termination_start'; pid = $targetId }
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $termination = [OarCommandTermination]::Begin($Child, $Terminate)
        if ($termination.Wait(10000)) {
            # A returned Kill does not establish root or descendant exit.
            & $Record @{ kind = 'termination_returned'; pid = $targetId; elapsedMs = $timer.ElapsedMilliseconds }
            $remainingMs = [int][Math]::Max(0, 10000 - $timer.ElapsedMilliseconds)
            $rootWaitMs = [Math]::Min(5000, $remainingMs)
            $rootExited = $Child.WaitForExit($rootWaitMs)
            & $Record @{ kind = 'termination_wait_returned'; pid = $targetId; rootExited = $rootExited; timeoutMs = $rootWaitMs }
        } else {
            & $Record @{ kind = 'termination_unreturned'; pid = $targetId; elapsedMs = $timer.ElapsedMilliseconds; timeoutMs = 10000 }
        }
    } catch {
        & $Record @{ kind = 'termination_error'; pid = $targetId; errorType = $_.Exception.GetBaseException().GetType().Name; elapsedMs = $timer.ElapsedMilliseconds }
    }
    & $Record @{ kind = 'stage_exit'; pid = $targetId; exitCode = 124 }
    # Do not sample CIM, dispose the shared Process, or join a blocked worker here.
    # Each checkpoint has already flushed; residual processes belong to runner cleanup.
    [Environment]::Exit(124)
}
