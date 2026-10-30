# Run the original CI command while periodically persisting Windows resource facts.
# No command lines, environment variables or executable paths enter the samples.
param(
    [Parameter(Mandatory)][string]$Stage,
    [Parameter(Mandatory)][string]$Command,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../oar-trial-run/windows-resources'),
    [ValidateRange(1000, 60000)][int]$IntervalMs = 5000,
    [ValidateRange(1, 720)][int]$MaxSamples = 720,
    [string]$ActiveTestsPath,
    [ValidateRange(1, 600)][int]$CaseTimeoutSeconds = 180,
    [ValidateRange(0, 3600)][int]$CommandTimeoutSeconds = 0
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows resource sampling requires Windows.' }
. (Join-Path $PSScriptRoot 'windows-termination.ps1')
[void][System.IO.Directory]::CreateDirectory($OutputDirectory)
$sampleFile = Join-Path $OutputDirectory "$Stage.jsonl"
$writer = [System.IO.StreamWriter]::new($sampleFile, $true, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true

function Write-Record([hashtable]$Record, [switch]$ToLog) {
    $Record.at = [DateTime]::UtcNow.ToString('o')
    $Record.stage = $Stage
    $json = $Record | ConvertTo-Json -Depth 5 -Compress
    if ($ToLog) {
        try {
            [Console]::Out.WriteLine("resources $json")
            [Console]::Out.Flush()
        } catch { } # A closed log pipe must not prevent termination.
    }
    try { $writer.WriteLine($json) } catch {
        # Timeout/termination checkpoints must not prevent the action they describe.
        if (-not $ToLog) { throw }
    }
}

function Write-Sample {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $memory = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory -OperationTimeoutSec 3
        $native = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,HandleCount -OperationTimeoutSec 3)
        $processes = @($native | ForEach-Object {
            @{
                pid = [long]$_.ProcessId
                parentPid = [long]$_.ParentProcessId
                name = $_.Name
                createdAt = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') }
                workingSetBytes = [long]$_.WorkingSetSize
                privateBytes = [long]$_.PrivatePageCount
                cpu100ns = [long]$_.KernelModeTime + [long]$_.UserModeTime
                handleCount = if ($null -eq $_.HandleCount) { $null } else { [long]$_.HandleCount }
            }
        })
        $nodeCount = @($processes | Where-Object { $_.name -eq 'node.exe' }).Count
        $shellCount = @($processes | Where-Object { $_.name -in @('powershell.exe', 'pwsh.exe') }).Count
        $handleCount = if (@($processes | Where-Object { $null -eq $_.handleCount }).Count -eq 0) {
            [long]($processes | Measure-Object -Property handleCount -Sum).Sum
        } else { $null }
        Write-Record @{
            kind = 'sample'; samplerPid = $PID; queryMs = $timer.ElapsedMilliseconds
            totalPhysicalBytes = [long]$memory.TotalVisibleMemorySize * 1024
            freePhysicalBytes = [long]$memory.FreePhysicalMemory * 1024
            processCount = $processes.Count; nodeCount = $nodeCount; shellCount = $shellCount
            handleCount = $handleCount
            processes = $processes
        }
        # Emit small checkpoints while the runner is alive, even if final artifact upload cannot run.
        $handles = if ($null -eq $handleCount) { 'unknown' } else { $handleCount }
        Write-Host "resources stage=$Stage freeMiB=$([math]::Round($memory.FreePhysicalMemory / 1024)) processes=$($processes.Count) node=$nodeCount shells=$shellCount handles=$handles queryMs=$($timer.ElapsedMilliseconds)"
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
    $commandTimer = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Record @{ kind = 'command_start'; pid = $child.Id; createdAt = $child.StartTime.ToUniversalTime().ToString('o') }
    $samples = 0
    while (-not $child.HasExited -and $samples -lt $MaxSamples) {
        Write-Sample
        $expired = @()
        if ($ActiveTestsPath -and (Test-Path $ActiveTestsPath)) {
            try {
                $progress = [System.IO.FileStream]::new($ActiveTestsPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
                $reader = [System.IO.StreamReader]::new($progress)
                try { $active = @($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
                $expired = @($active | Where-Object { ([DateTime]::UtcNow - [DateTime]$_.startedAt).TotalSeconds -ge $CaseTimeoutSeconds })
            } catch {
                Write-Record @{ kind = 'progress_read_error'; errorType = $_.Exception.GetType().Name }
            }
        }
        if ($expired.Count -gt 0 -or ($CommandTimeoutSeconds -gt 0 -and $commandTimer.Elapsed.TotalSeconds -ge $CommandTimeoutSeconds)) {
            foreach ($test in $expired) {
                Write-Record @{ kind = 'case_timeout'; name = $test.name; file = $test.file; timeoutSeconds = $CaseTimeoutSeconds } -ToLog
                Write-Host "FAILED: $($test.file) > $($test.name) exceeded the external $CaseTimeoutSeconds second case deadline."
            }
            if ($expired.Count -eq 0) { Write-Record @{ kind = 'command_timeout'; timeoutSeconds = $CommandTimeoutSeconds } -ToLog }
            # This exits 124 even if native tree termination does not return.
            Exit-TimedOutCommand -Child $child -Record { param($record) Write-Record $record -ToLog }
        }
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
