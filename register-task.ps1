$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runLivePath = Join-Path $repoRoot "run-live.ps1"
$taskName = "AttendanceBackend"
$fallbackTaskName = "AttendanceBackendUser"

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {}

try {
    Unregister-ScheduledTask -TaskName $fallbackTaskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runLivePath`""

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupTrigger.Delay = "PT30S"

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$logonTrigger.Delay = "PT15S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
    -UserId "NT AUTHORITY\SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger @($startupTrigger, $logonTrigger) `
        -Settings $settings `
        -Principal $principal `
        -ErrorAction Stop

    Write-Host "Registered $taskName to run at startup and logon as SYSTEM."
} catch {
    Write-Warning "Could not register the SYSTEM startup task. Falling back to the current user's logon task."

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentUserTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $currentUserTrigger.Delay = "PT15S"
    $currentUserPrincipal = New-ScheduledTaskPrincipal `
        -UserId $currentUser `
        -LogonType Interactive `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $fallbackTaskName `
        -Action $action `
        -Trigger $currentUserTrigger `
        -Settings $settings `
        -Principal $currentUserPrincipal `
        -ErrorAction Stop

    Write-Host "Registered $fallbackTaskName to run when $currentUser logs in."
}

