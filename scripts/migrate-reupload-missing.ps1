# Re-upload years with confirmed missing files
# immich-go will skip files already in Immich (hash dedup)

param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = $env:IMMICH_API_KEY,
    [string]$S3Remote  = "scaleway:photosync/transfers",
    [string]$TempDir   = "$env:TEMP\immich-reupload"
)
if (-not $ApiKey) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }

$immichGo = "$env:LOCALAPPDATA\immich-go\immich-go.exe"
$ErrorActionPreference = "Stop"

# Years with confirmed missing files, worst first
$years = @('unknown-date', '2025', '2021', '2017', '2020', '2019', '2022', '2023', '2024')

if (!(Test-Path $TempDir)) { New-Item -ItemType Directory -Path $TempDir -Force | Out-Null }

Write-Host "=== Re-uploading years with missing files ===" -ForegroundColor Cyan
Write-Host "immich-go will skip files already in Immich (hash dedup)"
Write-Host ""

foreach ($y in $years) {
    $yearTempPath = Join-Path $TempDir $y
    if (!(Test-Path $yearTempPath)) { New-Item -ItemType Directory -Path $yearTempPath -Force | Out-Null }

    Write-Host "[$y] Downloading from S3..." -ForegroundColor Yellow
    rclone copy "$S3Remote/$y" $yearTempPath --progress --transfers 8

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$y] ERROR: rclone download failed. Skipping." -ForegroundColor Red
        continue
    }

    $fileCount = (Get-ChildItem $yearTempPath -Recurse -File).Count
    Write-Host "[$y] Downloaded $fileCount files. Uploading to Immich..." -ForegroundColor Yellow

    if ($fileCount -eq 0) {
        Write-Host "[$y] No files - skipping." -ForegroundColor DarkGray
        continue
    }

    # Upload with retry-friendly settings
    $ErrorActionPreference = "Continue"
    cmd /c """$immichGo"" upload from-folder --server $ImmichUrl --api-key $ApiKey --folder-as-album FOLDER --recursive --no-ui --on-errors continue ""$yearTempPath""" 2>&1 | Write-Host
    $uploadExit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"

    if ($uploadExit -ne 0) {
        Write-Host "[$y] WARNING: immich-go reported errors (exit=$uploadExit). Some files may still have failed." -ForegroundColor Red
    } else {
        Write-Host "[$y] Upload complete." -ForegroundColor Green
    }

    # Clean up temp files for this year
    Write-Host "[$y] Cleaning up temp files..." -ForegroundColor DarkGray
    Remove-Item $yearTempPath -Recurse -Force
    Write-Host ""
}

# Clean up base temp
if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "=== Re-upload complete ===" -ForegroundColor Cyan
Write-Host "Run verify-filename-check.ps1 again to confirm all gaps are filled."
