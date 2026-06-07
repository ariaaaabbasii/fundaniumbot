$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$logDir = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDir 'local-monitor.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$existing = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object {
    $_.CommandLine -like '*src/funda-monitor.mjs*' -or
    $_.CommandLine -like '*src\funda-monitor.mjs*'
  } |
  Where-Object { $_.CommandLine -like "*$projectRoot*" }

if ($existing) {
  "[$(Get-Date -Format o)] Lokale Funda-monitor draait al. PID(s): $($existing.ProcessId -join ', ')" |
    Add-Content -LiteralPath $logFile
  exit 0
}

"[$(Get-Date -Format o)] Lokale Funda-monitor start." | Add-Content -LiteralPath $logFile
Set-Location -LiteralPath $projectRoot

$env:STATE_FILE = 'data/state.json'
node src/funda-monitor.mjs 2>&1 | ForEach-Object {
  $_ | Add-Content -LiteralPath $logFile -Encoding UTF8
}
