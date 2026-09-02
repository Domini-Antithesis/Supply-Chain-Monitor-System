# Supply Chain Monitor - one-command launcher (Windows).
#
#   .\start.ps1
#
# On a fresh install this starts the dashboard, opens the setup page in your
# browser, waits for you to save your keys, then brings the rest of the stack
# up automatically. On an already-configured install it just starts everything.
#
# NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
# BOM-less files as CP1252, so a non-ASCII character (an em-dash, a curly quote)
# decodes into bytes that PowerShell mistakes for string delimiters, producing
# confusing parse errors far from the real line. Keep it ASCII.

# Native commands like docker write progress to stderr; with EAP=Stop that can
# abort the script even on success, so errors are checked via exit codes instead.
$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host $msg -ForegroundColor Red }

# Both helpers shell out through cmd rather than using PowerShell's own `2>&1`.
# In Windows PowerShell 5.1 a native command's stderr becomes ErrorRecord objects,
# which print as a NativeCommandError stack trace even when the failure is
# expected. Letting cmd swallow the streams keeps the output clean, and cmd still
# propagates docker's real exit code.
function Test-DockerReady {
    cmd /c "docker info >NUL 2>&1"
    return ($LASTEXITCODE -eq 0)
}

function Get-DockerError {
    $lines = cmd /c "docker info 2>&1" |
        Select-String -Pattern "error|refused|denied|cannot|pipe" |
        Select-Object -First 3
    if ($lines) { return ($lines -join "`n") }
    return "docker info did not report a specific reason."
}

# --- Docker must be running -------------------------------------------------
Write-Step "Checking Docker"

if (-not (Test-DockerReady)) {
    Write-Warn "Docker is not responding yet. It may be starting up, or asleep in"
    Write-Warn "Resource Saver mode. Waiting up to 90 seconds for it to wake..."

    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 3
        if (Test-DockerReady) { $ready = $true; break }
    }

    if (-not $ready) {
        $detail = Get-DockerError
        Write-Host ""
        Write-Err "Could not reach the Docker engine."
        Write-Host ""
        Write-Host "Open Docker Desktop and wait for the whale icon to stop animating, then"
        Write-Host "run this again. Note that 'docker compose version' can succeed even when"
        Write-Host "the engine is down - it is a client-side command and never contacts it."
        Write-Host ""
        Write-Host "Docker reported:" -ForegroundColor DarkGray
        Write-Host $detail -ForegroundColor DarkGray
        exit 1
    }
}
Write-Ok "Docker is running."

$envPath = Join-Path $PSScriptRoot ".env"
$freshInstall = -not (Test-Path $envPath)

if ($freshInstall) {
    Write-Step "First run - starting the setup page"
    & docker compose up -d dashboard | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Err "Could not start the dashboard container."; exit 1 }

    $setupUrl = "http://localhost:8080/setup"
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:8080/api/setup/status" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { break }
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    Write-Ok "Opening $setupUrl"
    Start-Process $setupUrl
    Write-Host ""
    Write-Host "    Fill in the form in your browser. Each service is linked with instructions." -ForegroundColor Gray
    Write-Host "    This window is waiting and will finish setup automatically once you save." -ForegroundColor Gray
    Write-Host ""

    Write-Step "Waiting for you to save your configuration"
    $waited = 0
    while (-not (Test-Path $envPath)) {
        Start-Sleep -Seconds 2
        $waited = $waited + 2
        if (($waited % 60) -eq 0) {
            $minutes = [int]($waited / 60)
            Write-Warn "still waiting... ($minutes min)"
        }
        if ($waited -ge 3600) {
            Write-Err "Timed out after an hour. Re-run .\start.ps1 when you are ready."
            exit 1
        }
    }
    Write-Ok "Configuration saved."
}

# --- Bring the whole stack up ----------------------------------------------
Write-Step "Starting all services"
& docker compose up -d
if ($LASTEXITCODE -ne 0) { Write-Err "docker compose failed to start the stack."; exit 1 }

Write-Step "Running first-boot setup (account, Airtable tables, workflows)"
$null = & docker wait supply-chain-monitor-bootstrap 2>&1
$bootstrapLog = & docker logs supply-chain-monitor-bootstrap 2>&1 | Out-String
if ($bootstrapLog) {
    foreach ($line in ($bootstrapLog -split "`r?`n")) {
        if ($line.Trim()) { Write-Host "    $line" -ForegroundColor Gray }
    }
}

Write-Host ""
Write-Ok "Ready."
Write-Host ""
Write-Host "    Dashboard : http://localhost:8080"
Write-Host "    n8n       : http://localhost:5678"
Write-Host ""
Write-Host "    Stop everything with:  docker compose down"
Write-Host ""

if ($freshInstall) { Start-Process "http://localhost:8080" }
