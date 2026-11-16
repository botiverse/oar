# Diagnostic-only sampler. No commands, arguments, environment, paths or PIDs
# leave this process. PID + creation time is retained internally for attribution.
param([Parameter(Mandatory=$true)][string]$ControlFile)
$ErrorActionPreference = 'Stop'
$roots = @{}
$watch = [Diagnostics.Stopwatch]::StartNew()
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8)) }
function Timestamp { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
try {
    # Finish the first CIM query before declaring readiness. Its cost is retained.
    $initial = Timestamp
    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,UserModeTime,KernelModeTime,Name | Out-Null
    Emit @{phase='sampler_ready';at=(Timestamp);preparationMs=((Timestamp)-$initial)}
    while ($watch.Elapsed.TotalMinutes -lt 15) {
        # A partially replaced control file is retried on the next sample.
        # Console.In.ReadLineAsync can block synchronously on some runtimes.
        try { $control = [IO.File]::ReadAllText($ControlFile) | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 500; continue }
        if ($control.stop) { exit 0 }
        $active = @{}
        foreach ($message in $control.roots) {
            $key = [string]$message.ordinal
            $active[$key] = $true
            if (-not $roots.ContainsKey($key)) {
                $roots[$key] = @{pid=[int]$message.pid; earliest=[long]$message.earliest; latest=[long]$message.latest; members=@{}; total=0.0}
            }
        }
        foreach ($key in @($roots.Keys)) { if (-not $active.ContainsKey($key)) { $roots.Remove($key) } }
        if ($roots.Count -gt 0) {
            $started = Timestamp
            $table = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,UserModeTime,KernelModeTime,Name)
            $ended = Timestamp
            $byPid = @{}
            foreach ($p in $table) { $byPid[[int]$p.ProcessId] = $p }
            foreach ($key in @($roots.Keys)) {
                $root = $roots[$key]
                $candidate = $byPid[$root.pid]
                if ($root.members.Count -eq 0 -and $null -ne $candidate) {
                    $created = ([DateTimeOffset]$candidate.CreationDate).ToUnixTimeMilliseconds()
                    if ($created -ge $root.earliest -and $created -le $root.latest) {
                        $root.members[[string]$candidate.ProcessId] = @{created=$created;cpu=0.0;role='direct_child'}
                    }
                }
                # Expand only from a live matching parent identity in this snapshot.
                for ($depth=0; $depth -lt 16; $depth++) {
                    $added = $false
                    foreach ($p in $table) {
                        $parentKey = [string]$p.ParentProcessId
                        $parent = $root.members[$parentKey]
                        $liveParent = $byPid[[int]$p.ParentProcessId]
                        if ($null -eq $parent -or $null -eq $liveParent) { continue }
                        $parentCreated = ([DateTimeOffset]$liveParent.CreationDate).ToUnixTimeMilliseconds()
                        $created = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
                        if ($parentCreated -ne $parent.created -or $created -lt $parentCreated) { continue }
                        $memberKey = [string]$p.ProcessId
                        if ($root.members.ContainsKey($memberKey)) { continue }
                        $role = if ($p.Name -eq 'grok.exe') {'native_grok'} elseif ($p.Name -eq 'node.exe') {'node_bootstrap'} else {'descendant'}
                        $root.members[$memberKey] = @{created=$created;cpu=0.0;role=$role}
                        $added = $true
                    }
                    if (-not $added) { break }
                }
                $live = 0
                foreach ($memberKey in @($root.members.Keys)) {
                    $member = $root.members[$memberKey]
                    $p = $byPid[[int]$memberKey]
                    if ($null -eq $p) { continue }
                    $created = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
                    if ($created -ne $member.created) { continue }
                    $member.cpu = [Math]::Max($member.cpu, ([double]$p.UserModeTime + [double]$p.KernelModeTime) / 10000.0)
                    $live++
                }
                $total = 0.0; $native = 0.0; $bootstrap = 0.0
                foreach ($member in $root.members.Values) {
                    $total += $member.cpu
                    if ($member.role -eq 'native_grok') { $native += $member.cpu }
                    if ($member.role -eq 'node_bootstrap') { $bootstrap += $member.cpu }
                }
                Emit @{phase='cpu_sample';ordinal=[int]$key;at=$ended;queryStartedAt=$started;queryMs=($ended-$started);observedProcesses=$root.members.Count;liveProcesses=$live;cpuMs=$total;cpuDeltaMs=($total-$root.total);nativeCpuMs=$native;bootstrapCpuMs=$bootstrap}
                $root.total = $total
            }
        }
        Start-Sleep -Milliseconds 500
    }
    Emit @{phase='sampler_limit';at=(Timestamp)}
    exit 1
} catch {
    # Never print the native error, which can include machine-local details.
    Emit @{phase='sampler_error';at=(Timestamp)}
    exit 1
}
