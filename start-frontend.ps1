$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDir = Join-Path $repoRoot "frontend"
$nodeModulesDir = Join-Path $frontendDir "node_modules"

Set-Location $frontendDir

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js/npm was not found. Install Node.js, reopen PowerShell, then run .\start-frontend.ps1 again."
    exit 1
}

if (-not (Test-Path $nodeModulesDir)) {
    Write-Host "Installing frontend dependencies ..."
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

& npm.cmd run dev -- --host 127.0.0.1 --port 5173
