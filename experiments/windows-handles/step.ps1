# Deliberately leave one finite child alive when this workflow step ends.
param(
    [Parameter(Mandatory)][ValidateSet('inherited', 'file')][string]$Mode,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
[void][System.IO.Directory]::CreateDirectory($OutputDirectory)
$start = [System.Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
$start.UseShellExecute = $false
foreach ($argument in @((Join-Path $PSScriptRoot 'fixture.ts'), $Mode, $OutputDirectory)) {
    [void]$start.ArgumentList.Add($argument)
}
$child = [System.Diagnostics.Process]::Start($start)
if (-not $child.WaitForExit(15000)) { throw 'Synthetic parent did not exit within 15 seconds.' }
if ($child.ExitCode -ne 0) { throw "Synthetic parent failed: $($child.ExitCode)." }
$record = @{
    mode = $Mode
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    wrapperPid = $PID
    parentPid = $child.Id
    parentExited = $child.HasExited
    parentExitCode = $child.ExitCode
    powershell = $PSVersionTable.PSVersion.ToString()
    runtime = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
}
$child.Dispose()
$json = $record | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'wrapper-exiting.json'), $json)
[Console]::Out.WriteLine($json)
[Console]::Out.Flush()
