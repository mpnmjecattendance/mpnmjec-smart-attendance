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
        return $response.StatusCode -eq 200 -and $response.Content -like "*MPNMJEC Smart Attendance API*"
    } catch {
        return $false
    }
}

function Test-LocalFaceRecognition {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8000/health/face-recognition" -TimeoutSec 30
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

function Stop-BackendPort {
    try {
        $listeners = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique

        foreach ($processId in $listeners) {
            if ($processId -and $processId -gt 0) {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            }
        }

        Start-Sleep -Seconds 2
    } catch {
        Write-Host "Could not stop the existing backend process on port 8000. Close it manually if restart fails."
    }
}

function Start-Backend {
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startBackend, "-WithVision") `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $backendOutLog `
        -RedirectStandardError $backendErrLog
}

$backendReady = Test-LocalBackend
$faceReady = $backendReady -and (Test-LocalFaceRecognition)

if ($faceReady) {
    Write-Host "Backend API is already running with face recognition."
} else {
    if ($backendReady) {
        Write-Host "Backend API is running without face recognition. Restarting it with the vision runtime..."
        Stop-BackendPort
    } else {
        Write-Host "Starting backend API with face recognition..."
    }

    Start-Backend

    for ($attempt = 1; $attempt -le 180; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-LocalFaceRecognition) {
            Write-Host "Backend API is running with face recognition."
            break
        }
    }

    if (-not (Test-LocalFaceRecognition)) {
        Write-Host "Backend started, but face recognition is not ready yet. Check backend-live.err.log and backend-live.out.log."
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
