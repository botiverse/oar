$ErrorActionPreference = 'Stop'
$from = Get-Date
$watch = @()
try {
  foreach ($kind in @('Start', 'Stop')) {
    $data = "SELECT * FROM Win32_Process${kind}Trace WHERE ProcessName='opencode.exe'"
    $watch += Register-CimIndicationEvent -Query $data -SourceIdentifier "oar-opencode-$kind"
  }
  pnpm exec tsx experiments/opencode-windows-readiness/probe.ts 8
  $trialStatus = $LASTEXITCODE
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
