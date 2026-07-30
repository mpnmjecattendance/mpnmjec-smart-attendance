param(
    # Vision is required for enrollment and kiosk recognition.  Keep
    # -WithVision as a supported no-op for existing shortcuts; -CoreOnly is
    # intended only for API-only development.
    [switch]$WithVision,
    [switch]$CoreOnly
)

if ($WithVision -and $CoreOnly) {
    Write-Error "Use either -WithVision or -CoreOnly, not both."
    exit 1
}

$useVision = -not $CoreOnly

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"
$bundledVenvDir = Join-Path $backendDir "venv"
$localVenvDir = Join-Path $backendDir ".venv"
$venvDir = $bundledVenvDir
$pythonExe = Join-Path $venvDir "Scripts\python.exe"
$requirementsFileName = "requirements-core.txt"
$requirementsFile = Join-Path $backendDir $requirementsFileName
$visionInstaller = Join-Path $backendDir "install_vision.py"

function Test-PythonCommand {
    param(
        [string]$Command,
        [string[]]$Arguments = @()
    )

    try {
        & $Command @Arguments --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Find-PythonCommand {
    $candidates = @(
        @{ Command = "py"; Arguments = @("-3.11") },
        @{ Command = "py"; Arguments = @("-3") },
        @{ Command = "python"; Arguments = @() },
        @{ Command = "python3"; Arguments = @() }
    )

    foreach ($candidate in $candidates) {
        if (Test-PythonCommand -Command $candidate.Command -Arguments $candidate.Arguments) {
            return $candidate
        }
    }

    return $null
}

function Test-VenvPython {
    if (-not (Test-Path $pythonExe)) {
        return $false
    }

    return Test-PythonCommand -Command $pythonExe
}

function Test-BackendDependencies {
    try {
        $importCheck = "import fastapi, uvicorn, sqlalchemy, psycopg2"
        if ($useVision) {
            $importCheck = "$importCheck, cv2, insightface, numpy, onnxruntime"
        }

        & $pythonExe -c $importCheck *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

if (-not (Test-VenvPython)) {
    $venvDir = $localVenvDir
    $pythonExe = Join-Path $venvDir "Scripts\python.exe"
}

if (-not (Test-VenvPython)) {
    $pythonCommand = Find-PythonCommand

    if ($null -ne $pythonCommand) {
        Write-Host "Creating backend virtual environment at $venvDir ..."
        $venvArgs = $pythonCommand.Arguments + @("-m", "venv", $venvDir)
        & $pythonCommand.Command @venvArgs
        if ($LASTEXITCODE -ne 0 -or -not (Test-VenvPython)) {
            Write-Error "Could not create a working backend virtual environment."
            exit 1
        }
    } elseif (Get-Command uv -ErrorAction SilentlyContinue) {
        Write-Host "Python 3.11 was not found. Using uv to create the backend virtual environment ..."
        & uv venv --python 3.11 $venvDir
        if ($LASTEXITCODE -ne 0 -or -not (Test-VenvPython)) {
            Write-Error "Could not create a working backend virtual environment with uv."
            exit 1
        }
    } else {
        Write-Error "Python 3.11+ was not found. Install Python 3.11, reopen PowerShell, then run .\start-backend.ps1 again."
        exit 1
    }
}

if (-not (Test-BackendDependencies)) {
    Write-Host "Installing backend dependencies from $requirementsFileName ..."
    & $pythonExe -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    & $pythonExe -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    & $pythonExe -m pip install -r $requirementsFile
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    if ($useVision) {
        Write-Host "Installing face-recognition runtime ..."
        & $pythonExe $visionInstaller
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
}

Set-Location $backendDir
if ($useVision) {
    # Environment variables take precedence over backend/.env, so normal
    # project startup warms the model before a person reaches the kiosk.
    $env:PRELOAD_FACE_RECOGNITION = "true"
}
& $pythonExe -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
