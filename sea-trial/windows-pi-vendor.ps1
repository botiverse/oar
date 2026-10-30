# Keep each group visible in the GitHub jobs API even when no log is uploaded.
param(
    [Parameter(Mandatory)][ValidateSet('rpc', 'pi', 'mcp', 'shared')][string]$Group,
    [switch]$ListOnly
)
$ErrorActionPreference = 'Stop'

function Get-Group([string]$Name) {
    if ($Name -like 'pi-rpc*') { return 'rpc' }
    if ($Name -like 'pi-*' -or $Name -eq 'pi.vendor.test.ts') { return 'pi' }
    if ($Name -like '*mcp*') { return 'mcp' }
    return 'shared'
}

# Partition all vendor files, including future files, rather than maintaining
# an allowlist that could silently omit a new shared Pi RPC test.
$files = @(Get-ChildItem (Join-Path $PSScriptRoot 'vendor') -Filter '*.test.ts' -File |
    Where-Object { (Get-Group $_.Name) -eq $Group } |
    Sort-Object Name | ForEach-Object { "sea-trial/vendor/$($_.Name)" })
if ($files.Count -eq 0) { throw "No vendor files in group $Group" }
if ($ListOnly) { $files; return }

$runDirectory = if ($env:OAR_TRIAL_RUN_DIR) { $env:OAR_TRIAL_RUN_DIR } else { Join-Path $PSScriptRoot '../oar-trial-run' }
$env:OAR_PI_RPC_DIAGNOSTICS = Join-Path $runDirectory "pi-rpc-diagnostics/$Group"
[void][System.IO.Directory]::CreateDirectory($env:OAR_PI_RPC_DIAGNOSTICS)
Write-Host "Pi RPC vendor group ${Group}: $($files -join ', ')"
$arguments = ($files | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ' '
$command = 'pnpm vitest run ' + $arguments + ' 2>&1 | Tee-Object -FilePath "$env:OAR_PI_RPC_DIAGNOSTICS/vitest.log"'
& (Join-Path $PSScriptRoot 'windows-resources.ps1') -Stage "vendor-$Group" -ActiveTestsPath "$env:OAR_PI_RPC_DIAGNOSTICS/active-tests.json" -CaseTimeoutSeconds 180 -CommandTimeoutSeconds 300 -Command $command
exit $LASTEXITCODE
