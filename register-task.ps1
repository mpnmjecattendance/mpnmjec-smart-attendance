$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\dhine\Desktop\PROJECTS\ATTENDANCE-SYSTEM\start-backend.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AttendanceBackend" -Action $action -Trigger $trigger -Settings $settings -User "NT AUTHORITY\SYSTEM"
