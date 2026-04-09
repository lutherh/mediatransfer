# Mount Scaleway S3 bucket for Immich originals storage.
# Requires: rclone (installed), WinFsp (https://winfsp.dev/rel/)
#
# Usage:
#   .\scripts\mount-s3.ps1              # mount (foreground — Ctrl+C to stop)
#   .\scripts\mount-s3.ps1 -Background  # mount as background process
#   .\scripts\mount-s3.ps1 -Unmount     # unmount
#
# S3 credentials are read from .env (single source of truth):
#   SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_REGION
#
# Mount config is read from .env.immich:
#   RCLONE_BUCKET  = bucket name
#   RCLONE_PREFIX  = bucket subfolder for Immich (default: immich)
#   UPLOAD_LOCATION = local mount path
#
# No rclone remote or rclone.conf is needed — credentials are passed inline.

param(
    [switch]$Background,
    [switch]$Unmount
)

$ErrorActionPreference = 'Stop'

# ── Helper: parse a .env file into a hashtable ──
function Read-EnvFile([string]$Path) {
    $result = @{}
    if (Test-Path $Path) {
        Get-Content $Path | ForEach-Object {
            if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)') {
                $result[$Matches[1]] = $Matches[2].Trim('"', "'", ' ')
            }
        }
    }
    return $result
}

# ── Load config ──
$rootDir = Split-Path $PSScriptRoot

$mainEnv = Read-EnvFile (Join-Path $rootDir '.env')

$immichEnvFile = Join-Path $rootDir '.env.immich'
if (-not (Test-Path $immichEnvFile)) {
    Write-Error ".env.immich not found at $immichEnvFile — copy from .env.immich.example first."
    exit 1
}
$immichEnv = Read-EnvFile $immichEnvFile

# S3 credentials from .env
$accessKey = $mainEnv['SCW_ACCESS_KEY']
$secretKey = $mainEnv['SCW_SECRET_KEY']
$region    = $mainEnv['SCW_REGION']
$storageClass = $mainEnv['SCW_STORAGE_CLASS']

if (-not $accessKey -or -not $secretKey) {
    Write-Error "SCW_ACCESS_KEY and SCW_SECRET_KEY must be set in .env"
    exit 1
}

# Resolve endpoint from region (region code or full URL)
if ($region -match '^https?://') {
    $endpoint = $region
} else {
    $endpoint = "https://s3.$region.scw.cloud"
}

# Mount config from .env.immich
$bucket     = if ($immichEnv['RCLONE_BUCKET']) { $immichEnv['RCLONE_BUCKET'] } else { $mainEnv['SCW_BUCKET'] }
$prefix     = if ($immichEnv['RCLONE_PREFIX']) { $immichEnv['RCLONE_PREFIX'] } else { 'immich' }
$mountPoint = if ($immichEnv['UPLOAD_LOCATION']) { $immichEnv['UPLOAD_LOCATION'] } else { './data/immich-s3' }

if (-not $bucket) {
    Write-Error "No bucket configured. Set RCLONE_BUCKET in .env.immich or SCW_BUCKET in .env"
    exit 1
}

# Resolve relative path from mediatransfer root
if (-not [System.IO.Path]::IsPathRooted($mountPoint)) {
    $mountPoint = Join-Path (Split-Path $PSScriptRoot) $mountPoint
}
$mountPoint = [System.IO.Path]::GetFullPath($mountPoint)

# ── Pre-flight checks ──
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Write-Error "rclone is not installed. Install with: winget install Rclone.Rclone"
    exit 1
}

$winfspPaths = @("$env:ProgramFiles\WinFsp", "${env:ProgramFiles(x86)}\WinFsp")
$hasWinfsp = $winfspPaths | Where-Object { Test-Path $_ }
if (-not $hasWinfsp) {
    Write-Host "WinFsp is required for rclone mount on Windows." -ForegroundColor Red
    Write-Host "Install from: https://winfsp.dev/rel/" -ForegroundColor Yellow
    Write-Host "Or run:  winget install WinFsp.WinFsp" -ForegroundColor Yellow
    exit 1
}

# ── Unmount ──
if ($Unmount) {
    Write-Host "Unmounting $mountPoint ..."
    & rclone mount --unmount $mountPoint 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Unmounted successfully." -ForegroundColor Green
    } else {
        Write-Host "Unmount failed (mount may not be active)." -ForegroundColor Yellow
    }
    exit 0
}

# ── Ensure mount directory exists ──
if (-not (Test-Path $mountPoint)) {
    New-Item -ItemType Directory -Path $mountPoint -Force | Out-Null
}

# Use rclone's :s3: backend with inline credentials — no rclone.conf needed
$source = ":s3:${bucket}/${prefix}"

Write-Host "Mounting $source -> $mountPoint" -ForegroundColor Cyan
Write-Host "  Endpoint: $endpoint" -ForegroundColor Gray
Write-Host "  Bucket:   $bucket" -ForegroundColor Gray
Write-Host "  Prefix:   $prefix" -ForegroundColor Gray
Write-Host ""

$rcloneArgs = @(
    'mount'
    $source
    $mountPoint
    '--s3-provider', 'Scaleway'
    '--s3-access-key-id', $accessKey
    '--s3-secret-access-key', $secretKey
    '--s3-endpoint', $endpoint
    '--s3-region', 'nl-ams'
    $(if ($storageClass) { '--s3-storage-class'; $storageClass })
    '--vfs-cache-mode', 'writes'       # cache writes locally, read-through for reads
    '--vfs-write-back', '5s'           # flush writes to S3 after 5s
    '--vfs-cache-max-age', '1h'        # evict cached files after 1h
    '--vfs-cache-max-size', '2G'       # limit local cache to 2 GB
    '--vfs-read-chunk-size', '16M'     # initial read chunk
    '--vfs-read-chunk-size-limit', '64M'  # max read chunk (auto-scales)
    '--dir-cache-time', '30s'          # refresh directory listings every 30s
    '--poll-interval', '0'             # disable polling (S3 doesn't support it)
    '--transfers', '8'                 # parallel transfers
    '--s3-chunk-size', '16M'           # multipart upload chunk
    '--log-level', 'NOTICE'
)

if ($Background) {
    Write-Host "Starting rclone mount in background..." -ForegroundColor Yellow
    $rcloneArgs += '--daemon'
    & rclone @rcloneArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Mount running in background. Unmount with: .\scripts\mount-s3.ps1 -Unmount" -ForegroundColor Green
    } else {
        Write-Error "Failed to start rclone mount."
    }
} else {
    Write-Host "Mount running in foreground. Press Ctrl+C to stop." -ForegroundColor Yellow
    Write-Host ""
    & rclone @rcloneArgs
}
