# Sync existing local Immich library to S3 before enabling the rclone mount.
#
# This uploads library/ and upload/ from local data/immich/ to s3://bucket/immich/
# so that Immich's DB references still resolve after UPLOAD_LOCATION points to S3.
#
# Usage:
#   .\scripts\sync-immich-to-s3.ps1                  # dry run (default)
#   .\scripts\sync-immich-to-s3.ps1 -Execute          # actually sync
#   .\scripts\sync-immich-to-s3.ps1 -Execute -Verify  # sync + verify checksums
#
# S3 credentials are read from .env (same as mount scripts).
# No rclone remote or rclone.conf is needed.
# Immich should be STOPPED during sync to avoid writes to local path.

param(
    [switch]$Execute,
    [switch]$Verify
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

# ── Load config ──────────────────────────────────────────────────

$rootDir = Split-Path $PSScriptRoot

$mainEnv = Read-EnvFile (Join-Path $rootDir '.env')

$immichEnvFile = Join-Path $rootDir '.env.immich'
if (-not (Test-Path $immichEnvFile)) {
    Write-Host "ERROR: .env.immich not found" -ForegroundColor Red
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

if ($region -match '^https?://') {
    $endpoint = $region
    if ($region -match 's3\.([a-z0-9-]+)\.scw\.cloud') {
        $signingRegion = $Matches[1]
    } else {
        Write-Error "Cannot derive signing region from endpoint URL: $region"
        exit 1
    }
} else {
    $endpoint = "https://s3.$region.scw.cloud"
    $signingRegion = $region
}

$bucket = if ($immichEnv['RCLONE_BUCKET']) { $immichEnv['RCLONE_BUCKET'] } else { $mainEnv['SCW_BUCKET'] }
$prefix = if ($immichEnv['RCLONE_PREFIX']) { $immichEnv['RCLONE_PREFIX'] } else { 'immich' }
$localImmich = Join-Path $rootDir 'data\immich'

# Use :s3: backend with inline credentials
$destination = ":s3:${bucket}/${prefix}"
$s3Flags = @(
    '--s3-provider', 'Scaleway'
    '--s3-access-key-id', $accessKey
    '--s3-secret-access-key', $secretKey
    '--s3-endpoint', $endpoint
    '--s3-region', $signingRegion
    $(if ($storageClass) { '--s3-storage-class'; $storageClass })
)

# ── Pre-flight ───────────────────────────────────────────────────

Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Immich Local → S3 Migration" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Source:       $localImmich" -ForegroundColor Gray
Write-Host "  Destination:  $destination" -ForegroundColor Gray
Write-Host "  Mode:         $(if ($Execute) { 'EXECUTE' } else { 'DRY RUN' })" -ForegroundColor $(if ($Execute) { 'Yellow' } else { 'Green' })
Write-Host ""

if (-not (Test-Path $localImmich)) {
    Write-Host "ERROR: Local Immich directory not found: $localImmich" -ForegroundColor Red
    exit 1
}

# Only sync library/ and upload/ — thumbs, encoded-video, profile, backups stay local
$dirsToSync = @('library', 'upload')
$skippedDirs = @('thumbs', 'encoded-video', 'profile', 'backups')

Write-Host "Directories to sync to S3:" -ForegroundColor Cyan
foreach ($d in $dirsToSync) {
    $dirPath = Join-Path $localImmich $d
    if (Test-Path $dirPath) {
        $count = (Get-ChildItem $dirPath -Recurse -File).Count
        $sizeMB = [math]::Round(((Get-ChildItem $dirPath -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
        Write-Host "  ✓ $d/  ($count files, $sizeMB MB)" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $d/  (not found — skipping)" -ForegroundColor DarkGray
    }
}
Write-Host ""
Write-Host "Directories staying local (NOT synced):" -ForegroundColor Cyan
foreach ($d in $skippedDirs) {
    Write-Host "  – $d/" -ForegroundColor DarkGray
}
Write-Host ""

# ── Check Immich is stopped ──────────────────────────────────────

$immichRunning = docker ps --filter "name=immich_server" --format "{{.Status}}" 2>$null
if ($immichRunning) {
    Write-Host "WARNING: Immich server is running. Stop it first to avoid inconsistencies:" -ForegroundColor Yellow
    Write-Host "  docker compose -f docker-compose.immich.yml down" -ForegroundColor Yellow
    Write-Host ""
    if ($Execute) {
        $answer = Read-Host "Continue anyway? (y/N)"
        if ($answer -ne 'y') {
            Write-Host "Aborted." -ForegroundColor Red
            exit 1
        }
    }
}

# ── Sync each directory ──────────────────────────────────────────

$totalErrors = 0

foreach ($d in $dirsToSync) {
    $source = Join-Path $localImmich $d
    if (-not (Test-Path $source)) {
        Write-Host "[$d] Skipping — directory does not exist." -ForegroundColor DarkGray
        continue
    }

    $dest = "$destination/$d"
    Write-Host ""
    Write-Host "[$d] Syncing $source → $dest" -ForegroundColor Cyan

    $rcloneArgs = @(
        'sync'
        $source
        $dest
        ) + $s3Flags + @(
        '--progress'
        '--transfers', '8'
        '--checkers', '16'
        '--s3-chunk-size', '16M'
        '--s3-upload-concurrency', '4'
        '--fast-list'
        '--log-level', 'INFO'
        '--stats', '10s'
        '--stats-one-line'
    )

    if (-not $Execute) {
        $rcloneArgs += '--dry-run'
        Write-Host "[$d] DRY RUN — no files will be copied." -ForegroundColor Green
    }

    & rclone @rcloneArgs 2>&1 | ForEach-Object {
        $line = $_.ToString()
        if ($line -match 'ERROR') {
            Write-Host "  $line" -ForegroundColor Red
            $totalErrors++
        } elseif ($line -match 'NOTICE|Transferred') {
            Write-Host "  $line" -ForegroundColor Yellow
        } else {
            Write-Host "  $line" -ForegroundColor Gray
        }
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$d] rclone exited with code $LASTEXITCODE" -ForegroundColor Red
        $totalErrors++
    } else {
        Write-Host "[$d] Sync completed." -ForegroundColor Green
    }
}

# ── Verification ─────────────────────────────────────────────────

if ($Verify -and $Execute) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  Verification: comparing checksums" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan

    foreach ($d in $dirsToSync) {
        $source = Join-Path $localImmich $d
        if (-not (Test-Path $source)) { continue }

        $dest = "$destination/$d"
        Write-Host ""
        Write-Host "[$d] Checking $source ↔ $dest" -ForegroundColor Cyan

        $checkArgs = @(
            'check'
            $source
            $dest
            ) + $s3Flags + @(
            '--one-way'
            '--fast-list'
            '--log-level', 'INFO'
        )

        & rclone @checkArgs 2>&1 | ForEach-Object {
            $line = $_.ToString()
            if ($line -match 'ERROR|differ') {
                Write-Host "  $line" -ForegroundColor Red
                $totalErrors++
            } else {
                Write-Host "  $line" -ForegroundColor Gray
            }
        }

        if ($LASTEXITCODE -eq 0) {
            Write-Host "[$d] Verification PASSED." -ForegroundColor Green
        } else {
            Write-Host "[$d] Verification FAILED — some files differ." -ForegroundColor Red
            $totalErrors++
        }
    }
}

# ── Summary ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
if ($totalErrors -gt 0) {
    Write-Host "  COMPLETED with $totalErrors error(s). Review the log above." -ForegroundColor Red
} elseif (-not $Execute) {
    Write-Host "  DRY RUN complete — no changes made." -ForegroundColor Green
    Write-Host "  Run with -Execute to sync, or -Execute -Verify to sync + verify." -ForegroundColor Yellow
} else {
    Write-Host "  SYNC COMPLETE — all files uploaded to S3." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor Cyan
    Write-Host "    1. Run the verify script:  npx tsx scripts/verify-s3-immich-compat.ts" -ForegroundColor Gray
    Write-Host "    2. Start the S3 mount:     .\scripts\mount-s3.ps1" -ForegroundColor Gray
    Write-Host "    3. Start Immich:           docker compose -f docker-compose.immich.yml up -d" -ForegroundColor Gray
    Write-Host "    4. Verify Immich works (browse photos, check for missing thumbnails)" -ForegroundColor Gray
    Write-Host "    5. Once confirmed, you can delete local originals:" -ForegroundColor Gray
    Write-Host "       Remove-Item -Recurse data\immich\library, data\immich\upload" -ForegroundColor DarkGray
}
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
