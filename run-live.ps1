$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ngrokExe = Join-Path $repoRoot "ngrok.exe"
$ngrokConfig = Join-Path $repoRoot "ngrok.yml"
$startBackend = Join-Path $repoRoot "start-backend.ps1"
$backendOutLog = Join-Path $repoRoot "backend-live.out.log"
$backendErrLog = Join-Path $repoRoot "backend-live.err.log"
$ngrokOutLog = Join-Path $repoRoot "ngrok-live.out.log"
$ngrokErrLog = Join-Path $repoRoot "ngrok-live.err.log"
$ngrokDomain = "trombone-jailbreak-retold.ngrok-free.dev"

function Test-LocalBackend {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8000/" -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-NgrokBackend {
    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "https://$ngrokDomain/" `
            -Headers @{ "ngrok-skip-browser-warning" = "true" } `
            -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-LocalBackend) {
    Write-Host "Backend API is already running."
} else {
    Write-Host "Starting backend API..."
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startBackend, "-CoreOnly") `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $backendOutLog `
        -RedirectStandardError $backendErrLog

    for ($attempt = 1; $attempt -le 30; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-LocalBackend) {
            Write-Host "Backend API is running."
            break
        }
    }
}

if (Test-NgrokBackend) {
    Write-Host "ngrok tunnel is already connected."
} elseif (Get-Process -Name "ngrok" -ErrorAction SilentlyContinue) {
    Write-Host "ngrok is already running. If the public URL is unhealthy, restart ngrok manually."
} else {
    Write-Host "Starting ngrok tunnel..."
    Start-Process `
        -FilePath $ngrokExe `
        -ArgumentList @("http", "8000", "--domain", $ngrokDomain, "--config", $ngrokConfig) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $ngrokOutLog `
        -RedirectStandardError $ngrokErrLog
}
