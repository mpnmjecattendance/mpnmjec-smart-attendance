$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ngrokExe = Join-Path $repoRoot "ngrok.exe"
$ngrokConfig = Join-Path $repoRoot "ngrok.yml"
$startBackend = Join-Path $repoRoot "start-backend.ps1"

Write-Host "Starting ngrok tunnel..."
Start-Process -FilePath $ngrokExe -ArgumentList "http 8000 --domain trombone-jailbreak-retold.ngrok-free.dev --config `"$ngrokConfig`"" -WindowStyle Hidden

Write-Host "Starting backend server..."
& $startBackend
