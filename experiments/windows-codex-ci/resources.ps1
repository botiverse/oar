# Observation only: no CIM warmup, test deadlines or process termination.
param(
    [Parameter(Mandatory)][string]$OutputFile,
    [Parameter(Mandatory)][string]$StopFile
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This sampler requires Windows.' }
$writer = [System.IO.StreamWriter]::new($OutputFile, $true, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
function Write-Record([hashtable]$Record) {
    $Record.at = [DateTime]::UtcNow.ToString('o')
    $Record.samplerPid = $PID
    $writer.WriteLine(($Record | ConvertTo-Json -Depth 6 -Compress))
}
try {
    Write-Record @{ kind = 'sampler_started'; logicalProcessors = [Environment]::ProcessorCount }
    while (-not (Test-Path -LiteralPath $StopFile)) {
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            # Use performance counters rather than the CIM process table whose
            # first-use latency is one of the quantities under investigation.
            $counterNames = @(
                '\Processor(_Total)\% Processor Time',
                '\Memory\Available MBytes',
                '\PhysicalDisk(_Total)\Avg. Disk sec/Transfer',
                '\PhysicalDisk(_Total)\Disk Transfers/sec',
                '\PhysicalDisk(_Total)\Current Disk Queue Length'
            )
            $counters = @(Get-Counter -Counter $counterNames -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop |
                Select-Object -ExpandProperty CounterSamples | ForEach-Object {
                    @{ counter = $_.Path.Substring($_.Path.IndexOf('\', 2)); value = $_.CookedValue; status = $_.Status }
                })
            Write-Record @{ kind = 'counters'; elapsedMs = $timer.ElapsedMilliseconds; values = $counters }
        } catch {
            Write-Record @{ kind = 'counter_error'; errorType = $_.Exception.GetType().Name; elapsedMs = $timer.ElapsedMilliseconds }
        }
        $timer.Restart()
        $processes = @()
        $unreadable = 0
        foreach ($process in [System.Diagnostics.Process]::GetProcesses()) {
            try {
                # Names and numeric identities only; never args, env or paths.
                $processes += @{
                    pid = $process.Id; name = $process.ProcessName
                    createdAt = $process.StartTime.ToUniversalTime().ToString('o')
                    cpuMs = $process.TotalProcessorTime.TotalMilliseconds
                    workingSetBytes = $process.WorkingSet64; privateBytes = $process.PrivateMemorySize64
                    handles = $process.HandleCount; threads = $process.Threads.Count
                }
            } catch { $unreadable += 1 } finally { $process.Dispose() }
        }
        Write-Record @{ kind = 'processes'; elapsedMs = $timer.ElapsedMilliseconds; unreadable = $unreadable; values = $processes }
        for ($i = 0; $i -lt 50 -and -not (Test-Path -LiteralPath $StopFile); $i++) { Start-Sleep -Milliseconds 100 }
    }
    Write-Record @{ kind = 'sampler_stopped' }
} finally { $writer.Dispose() }
