# Start / stop / restart the MediaTransfer + Immich stacks.
#
# Cross-platform PowerShell rewrite of start-all.sh. Works on:
#   - Windows PowerShell 5.1 (ships with Windows 10+)
#   - PowerShell 7+ (pwsh) on Windows / Linux / macOS
#
# The rclone-cleanup sidecar defined in docker-compose.immich.yml handles
# stale FUSE mounts inside the Docker host namespace as a defense-in-depth
# measure. On Windows + Docker Desktop (WSL2) we additionally clear stale
# fuse.rclone mounts in the docker-desktop VM before `up` / `start` /
# `restart`, because Docker refuses to create the cleanup sidecar itself
# when a host bind path has a dead FUSE endpoint. See
# plans/05-host-side-fuse-cleanup.md and plans/03-stale-fuse-mounts.md.
#
# Usage:
#   ./start-all.ps1 [up|start|down|stop|restart|status|ps|logs [service...]]

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Action = 'up',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 has no automatic $IsWindows variable.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    $isWin = $true
} else {
    $isWin = [bool]$IsWindows
}

$ScriptDir = $PSScriptRoot
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location -LiteralPath $RootDir

$composeFiles = @('-f', 'docker-compose.yml', '-f', 'docker-compose.immich.yml')

function Wait-Docker {
    $retries = 30
    while ($true) {
        & docker info *> $null
        if ($LASTEXITCODE -eq 0) { return }
        $retries--
        if ($retries -le 0) {
            Write-Error 'ERROR: Docker daemon not available after 60 seconds'
            exit 1
        }
        Write-Host 'Waiting for Docker daemon...'
        Start-Sleep -Seconds 2
    }
}

function Assert-Compose {
    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "ERROR: 'docker compose' (v2) is required. Install Docker Desktop or the compose-plugin package."
        exit 1
    }
}

function Clear-StaleFuseMounts {
    # Only relevant on Windows with Docker Desktop (WSL2).
    if (-not $isWin) { return }
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { return }

    # Lazy-unmount any stale rclone FUSE endpoints in the docker-desktop
    # VM. Required because Docker refuses to create containers when the
    # host bind path has a dead FUSE endpoint, which prevents the
    # in-container rclone-cleanup sidecar from running.
    # See plans/03-stale-fuse-mounts.md and plans/05-host-side-fuse-cleanup.md.
    # NOTE: the awk `$3` is escaped with a backtick so PowerShell does not
    # try to interpolate it. Backslash is not a PS escape character.
    $probeCmd = 'mount 2>/dev/null | grep fuse.rclone | awk ''{print $3}'''
    $stale = wsl -d docker-desktop -- sh -c $probeCmd 2>$null
    if (-not $stale) { return }

    $count = ($stale | Measure-Object).Count
    Write-Host "Cleaning $count stale FUSE mount(s) in docker-desktop VM..."
    $unmountCmd = $probeCmd + ' | xargs -r -n1 umount -l 2>/dev/null'
    wsl -d docker-desktop -- sh -c $unmountCmd *> $null
}

function Invoke-Up {
    Write-Host 'Starting all services...'
    & docker compose @composeFiles up -d --remove-orphans
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ''
    Write-Host 'All services started.'
    & docker compose @composeFiles ps --format 'table {{.Name}}\t{{.Status}}'
}

function Invoke-Down {
    Write-Host 'Stopping all services...'
    & docker compose @composeFiles down
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Wait-Docker
Assert-Compose

# Call before any `docker compose up` action:
if ($Action -in 'up', 'start', 'restart') { Clear-StaleFuseMounts }

switch ($Action) {
    { $_ -in 'up', 'start' } {
        Invoke-Up
        break
    }

    { $_ -in 'down', 'stop' } {
        Invoke-Down
        break
    }

    'restart' {
        Invoke-Down
        Invoke-Up
        break
    }

    { $_ -in 'status', 'ps' } {
        & docker compose @composeFiles ps
        break
    }

    'logs' {
        & docker compose @composeFiles logs -f @Rest
        break
    }

    default {
        Write-Error "Usage: start-all.ps1 {up|start|down|stop|restart|status|ps|logs [service...]}"
        exit 1
    }
}
