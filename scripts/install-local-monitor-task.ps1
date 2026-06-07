$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$startScript = Join-Path $projectRoot 'scripts\start-local-monitor.ps1'
$taskName = 'Funda laptop monitor'

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" `
  -WorkingDirectory $projectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 7) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Runs the local Funda Telegram monitor while this laptop is logged in.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "Geinstalleerd en gestart: $taskName"
