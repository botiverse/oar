param([Parameter(Mandatory)][string]$ProcessIds)

$ErrorActionPreference = 'Stop'
$rows = @{}
foreach ($row in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate) {
    $rows[[int]$row.ProcessId] = $row
}
$seen = @{}
foreach ($startId in $ProcessIds.Split(',')) {
    $currentId = [int]$startId
    while ($currentId -gt 0 -and $rows.ContainsKey($currentId) -and !$seen.ContainsKey($currentId)) {
        $row = $rows[$currentId]
        $seen[$currentId] = [ordered]@{
            pid = $currentId
            ppid = [int]$row.ParentProcessId
            name = $row.Name
            start = if ($null -ne $row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') }
        }
        $currentId = [int]$row.ParentProcessId
    }
}
ConvertTo-Json -InputObject @($seen.Values) -Compress
