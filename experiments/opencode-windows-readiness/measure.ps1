$ErrorActionPreference = 'Stop'
$from = Get-Date
$watch = @()
try {
  foreach ($kind in @('Start', 'Stop')) {
    $data = "SELECT * FROM Win32_Process${kind}Trace WHERE ProcessName='opencode.exe'"
    $watch += Register-CimIndicationEvent -Query $data -SourceIdentifier "oar-opencode-$kind"
  }
  $trialStatus = 0
  $patterns = [ordered]@{
    readiness = 'Standalone server exited before reporting readiness'
    effort = 'effort not found: oar-no-such-effort'
    sqlite = 'SQLITE_BUSY|SQLITE_LOCKED|database is (locked|busy)'
    dbOpen = 'SQLITE_CANTOPEN|unable to open database file'
    dbIO = 'SQLITE_IOERR|disk I/O error|locking protocol'
    dbCorrupt = 'SQLITE_CORRUPT|database disk image is malformed'
    bind = 'EADDRINUSE|WSAEADDRINUSE|address already in use'
    busy = 'EBUSY|sharing violation|used by another process'
    missing = 'ENOENT|the system cannot find'
    access = 'EACCES|EPERM|access is denied'
    pipe = 'EPIPE|broken pipe|ERR_STREAM_PREMATURE_CLOSE'
    memory = 'out of memory|allocation failed|pagefile'
    crash = 'panic|segmentation fault|access violation|Bun has crashed'
    fatal = '\b(FATAL|uncaught exception|unhandled rejection)\b'
  }
  # Stream only fixed diagnostics and sea-trial case identifiers. Verbose native
  # logs and synthetic provider traces stay on the ephemeral runner.
  for ($round = 1; $round -le 3; $round++) {
    [ordered]@{ round = $round; workers = $env:OAR_TEST_CONCURRENCY; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
    pnpm run sea-trial 2>&1 | ForEach-Object {
      $line = [string]$_
      $signals = @($patterns.Keys | Where-Object { $line -match $patterns[$_] })
      $case = $null
      if ($line -match '^(PASS|FAIL|SKIP)\s+([a-z0-9][a-z0-9.-]+)') { $case = "$($Matches[1]) $($Matches[2])" }
      if ($signals.Count -or $case) {
        [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); round = $round; signals = $signals; result = $case } | ConvertTo-Json -Compress
      }
    }
    $code = $LASTEXITCODE
    [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); round = $round; suiteExit = $code } | ConvertTo-Json -Compress
    if ($code -ne 0) { $trialStatus = $code }
  }
  Start-Sleep -Seconds 1
  foreach ($event in Get-Event | Where-Object SourceIdentifier -like 'oar-opencode-*') {
    $process = $event.SourceEventArgs.NewEvent
    [ordered]@{ kind = $event.SourceIdentifier; at = [DateTime]::FromFileTimeUtc([long]$process.TIME_CREATED).ToString('o'); pid = $process.ProcessID; parent = $process.ParentProcessID; exitStatus = $process.ExitStatus } | ConvertTo-Json -Compress
  }
  # Windows records an application crash in this log even when the child emitted nothing on stderr.
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $from; Id = 1000 } -ErrorAction SilentlyContinue | ForEach-Object {
    [xml]$entry = $_.ToXml()
    $fields = @{}
    foreach ($field in $entry.Event.EventData.Data) { $fields[[string]$field.Name] = [string]$field.'#text' }
    if ($fields.AppName -eq 'opencode.exe') {
      [ordered]@{ kind = 'application_error'; at = $_.TimeCreated.ToUniversalTime().ToString('o'); pid = $fields.ProcessId; exceptionCode = $fields.ExceptionCode } | ConvertTo-Json -Compress
    }
  }
  exit $trialStatus
} finally {
  Get-EventSubscriber | Where-Object SourceIdentifier -like 'oar-opencode-*' | Unregister-Event
}
