# Run the original CI command while periodically persisting Windows resource facts.
# No command lines, environment variables or executable paths enter the samples.
param(
    [Parameter(Mandatory)][string]$Stage,
    [Parameter(Mandatory)][string]$Command,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../oar-trial-run/windows-resources'),
    [ValidateRange(1000, 60000)][int]$IntervalMs = 5000,
    [ValidateRange(1, 720)][int]$MaxSamples = 720
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows resource sampling requires Windows.' }
[void][System.IO.Directory]::CreateDirectory($OutputDirectory)
$sampleFile = Join-Path $OutputDirectory "$Stage.jsonl"
$writer = [System.IO.StreamWriter]::new($sampleFile, $true, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true

function Write-Record([hashtable]$Record) {
    $Record.at = [DateTime]::UtcNow.ToString('o')
    $Record.stage = $Stage
    $writer.WriteLine(($Record | ConvertTo-Json -Depth 5 -Compress))
}

function Write-Sample {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $memory = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory -OperationTimeoutSec 3
        $native = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime -OperationTimeoutSec 3)
        $processes = @($native | ForEach-Object {
            @{
                pid = [long]$_.ProcessId
                parentPid = [long]$_.ParentProcessId
                name = $_.Name
                createdAt = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') }
                workingSetBytes = [long]$_.WorkingSetSize
                privateBytes = [long]$_.PrivatePageCount
                cpu100ns = [long]$_.KernelModeTime + [long]$_.UserModeTime
            }
        })
        $nodeCount = @($processes | Where-Object { $_.name -eq 'node.exe' }).Count
        $shellCount = @($processes | Where-Object { $_.name -in @('powershell.exe', 'pwsh.exe') }).Count
        Write-Record @{
            kind = 'sample'; samplerPid = $PID; queryMs = $timer.ElapsedMilliseconds
            totalPhysicalBytes = [long]$memory.TotalVisibleMemorySize * 1024
            freePhysicalBytes = [long]$memory.FreePhysicalMemory * 1024
            processCount = $processes.Count; nodeCount = $nodeCount; shellCount = $shellCount
            processes = $processes
        }
        # Emit small checkpoints while the runner is alive, even if final artifact upload cannot run.
        Write-Host "resources stage=$Stage freeMiB=$([math]::Round($memory.FreePhysicalMemory / 1024)) processes=$($processes.Count) node=$nodeCount shells=$shellCount queryMs=$($timer.ElapsedMilliseconds)"
    } catch {
        # Diagnostic failure must neither hide a native failure nor stop the original test command.
        Write-Record @{ kind = 'sample_error'; errorType = $_.Exception.GetType().Name; queryMs = $timer.ElapsedMilliseconds }
        Write-Warning 'Resource sample unavailable; see the sample_error record.'
    }
}

$child = $null
try {
    Write-Record @{ kind = 'stage_start'; samplerPid = $PID }
    Write-Sample
    $start = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.WorkingDirectory = (Get-Location).Path
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ('$ErrorActionPreference = "Stop"; & { ' + $Command + ' }; exit $LASTEXITCODE'))) {
        [void]$start.ArgumentList.Add($argument)
    }
    # Standard streams are inherited, so CI still receives the native test output.
    $child = [System.Diagnostics.Process]::Start($start)
    Write-Record @{ kind = 'command_start'; pid = $child.Id; createdAt = $child.StartTime.ToUniversalTime().ToString('o') }
    $samples = 0
    while (-not $child.HasExited -and $samples -lt $MaxSamples) {
        Write-Sample
        $samples += 1
        [void]$child.WaitForExit($IntervalMs)
    }
    if (-not $child.HasExited) { Write-Record @{ kind = 'sampling_limit'; samples = $samples } }
    # The sampling limit bounds diagnostic volume, not the test's existing deadline.
    $child.WaitForExit()
    $code = $child.ExitCode
    Write-Sample
    Write-Record @{ kind = 'stage_exit'; pid = $child.Id; exitCode = $code }
} finally {
    if ($null -ne $child) { $child.Dispose() }
    $writer.Dispose()
}
exit $code
