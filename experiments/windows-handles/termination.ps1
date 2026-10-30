# A prototype of a bounded kill, not a change to the production CI monitor.
param(
    [Parameter(Mandatory)][ValidateSet('normal', 'unreturned')][string]$Mode,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
[void][System.IO.Directory]::CreateDirectory($OutputDirectory)
function Write-Record([hashtable]$Record) {
    $Record.at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $json = $Record | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText((Join-Path $OutputDirectory 'termination.jsonl'), "$json`n")
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
public static class SyntheticTermination {
    public static Task Begin(Process process, bool neverReturn, string enteredPath) {
        return Task.Run(() => {
            File.WriteAllText(enteredPath, neverReturn ? "unreturned" : "normal");
            if (neverReturn) { Thread.Sleep(Timeout.Infinite); }
            process.Kill(true);
        });
    }
}
'@
$start = [System.Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
$start.UseShellExecute = $false
# The target owns pipes into this helper, not the workflow step's output handles.
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.RedirectStandardInput = $true
foreach ($argument in @((Join-Path $PSScriptRoot 'fixture.ts'), 'child', $OutputDirectory)) {
    [void]$start.ArgumentList.Add($argument)
}
$target = [System.Diagnostics.Process]::Start($start)
$target.StandardInput.Close()
$readyPath = Join-Path $OutputDirectory 'child-ready.json'
$readyTimer = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path $readyPath) -and $readyTimer.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 25 }
if (-not (Test-Path $readyPath) -or $target.HasExited) { throw 'The target must be ready and alive before termination.' }
Write-Record @{ kind = 'termination_start'; pid = $target.Id; mode = $Mode; readyAndAlive = $true }
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$kill = [SyntheticTermination]::Begin($target, ($Mode -eq 'unreturned'), (Join-Path $OutputDirectory 'kill-entered.txt'))
try {
    $returned = $kill.Wait(10000)
    Write-Record @{
        kind = if ($returned) { 'termination_returned' } else { 'termination_unreturned' }
        pid = $target.Id; elapsedMs = $timer.ElapsedMilliseconds; timeoutMs = 10000
    }
} catch {
    Write-Record @{ kind = 'termination_error'; errorType = $_.Exception.GetType().Name; elapsedMs = $timer.ElapsedMilliseconds }
}
Write-Record @{ kind = 'stage_exit'; exitCode = 124 }
# ThreadPool workers are background threads. Exiting does not join the blocked kill.
[Environment]::Exit(124)
