param(
    [Parameter(Mandatory)][ValidateSet('normal', 'unreturned', 'error', 'returned-live')][string]$Mode,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../sea-trial/windows-termination.ps1')
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class TerminationFault {
    public static Action<Process> Create(string mode, string entered) {
        return process => {
            if (process.HasExited) { throw new Exception("The target must still be alive."); }
            File.WriteAllText(entered, process.Id.ToString());
            if (mode == "unreturned") { Thread.Sleep(Timeout.Infinite); }
            if (mode == "returned-live") { Thread.Sleep(8000); return; }
            throw new InvalidOperationException("Synthetic termination failure.");
        };
    }
}
'@
$start = [System.Diagnostics.ProcessStartInfo]::new($NodePath)
$start.UseShellExecute = $false
foreach ($argument in @((Join-Path $PSScriptRoot 'windows-termination-child.ts'), $OutputDirectory)) {
    [void]$start.ArgumentList.Add($argument)
}
$target = [System.Diagnostics.Process]::Start($start)
$readyPath = Join-Path $OutputDirectory 'ready.json'
$timer = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path $readyPath) -and $timer.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 25 }
if (-not (Test-Path $readyPath) -or $target.HasExited) { throw 'The target must be ready and alive before termination.' }
$record = {
    param([hashtable]$Entry)
    $Entry.at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $json = $Entry | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText((Join-Path $OutputDirectory 'records.jsonl'), "$json`n")
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}
if ($Mode -eq 'normal') { Exit-TimedOutCommand -Child $target -Record $record }
else { Exit-TimedOutCommand -Child $target -Record $record -Terminate ([TerminationFault]::Create($Mode, (Join-Path $OutputDirectory 'entered.txt'))) }
throw 'The timed-out monitor must not return.'
