$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runLivePath = Join-Path $repoRoot "run-live.ps1"

try {
    Unregister-ScheduledTask -TaskName "AttendanceBackend" -Confirm:$false
} catch {}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runLivePath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AttendanceBackend" -Action $action -Trigger $trigger -Settings $settings -User "NT AUTHORITY\SYSTEM"

