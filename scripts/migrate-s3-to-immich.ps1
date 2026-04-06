<#
.SYNOPSIS
  Migrate photos from Scaleway S3 (transfers/) into Immich.
  Downloads in year-based batches, uploads via immich-go, then cleans up.

.NOTES
  - Requires: rclone (configured with "scaleway" remote), immich-go
  - Does NOT keep permanent local copies — each batch is deleted after upload
  - Resume-safe: re-running skips years already completed
#>

param(
    [string]$ImmichUrl   = "http://localhost:2283",
    [string]$ApiKey      = "***REMOVED***",
    [string]$S3Remote    = "scaleway:photosync/transfers",
    [string]$TempDir     = "$env:TEMP\immich-migration",
    [string]$ImmichGo    = "$env:LOCALAPPDATA\immich-go\immich-go.exe",
    [string]$DoneFile    = "$PSScriptRoot\migration-done-years.txt"
)

$ErrorActionPreference = "Stop"

# Create temp dir
if (!(Test-Path $TempDir)) { New-Item -ItemType Directory -Path $TempDir -Force | Out-Null }

# Load already-completed years
$completedYears = @()
if (Test-Path $DoneFile) {
    $completedYears = Get-Content $DoneFile | Where-Object { $_.Trim() -ne "" }
}

Write-Host "=== Immich S3 Migration ===" -ForegroundColor Cyan
Write-Host "Source:    $S3Remote"
Write-Host "Immich:    $ImmichUrl"
Write-Host "Temp dir:  $TempDir"
Write-Host ""

# List year folders from S3
Write-Host "Listing year folders from S3..." -ForegroundColor Yellow
$yearDirs = rclone lsd $S3Remote 2>&1 | ForEach-Object {
    $_.Trim() -replace '.*\s+', ''
} | Where-Object { $_ -ne "" } | Sort-Object | Get-Unique

Write-Host "Found years: $($yearDirs -join ', ')" -ForegroundColor Green
Write-Host ""

foreach ($year in $yearDirs) {
    if ($completedYears -contains $year) {
        Write-Host "[$year] Already completed, skipping." -ForegroundColor DarkGray
        continue
    }

    $yearTempPath = Join-Path $TempDir $year

    Write-Host "[$year] Downloading from S3..." -ForegroundColor Yellow
    rclone copy "$S3Remote/$year" $yearTempPath --progress --transfers 8

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$year] ERROR: rclone download failed. Skipping." -ForegroundColor Red
        continue
    }

    # Count files
    $fileCount = (Get-ChildItem $yearTempPath -Recurse -File).Count
    Write-Host "[$year] Downloaded $fileCount files. Uploading to Immich..." -ForegroundColor Yellow

    if ($fileCount -eq 0) {
        Write-Host "[$year] No files found, marking complete." -ForegroundColor DarkGray
        $year | Out-File -Append -FilePath $DoneFile
        continue
    }

    # Upload to Immich with album creation based on folder names
    # Temporarily relax error handling since immich-go writes to stderr on partial failures
    $ErrorActionPreference = "Continue"
    cmd /c """$ImmichGo"" upload from-folder --server $ImmichUrl --api-key $ApiKey --folder-as-album FOLDER --recursive --no-ui --on-errors continue ""$yearTempPath""" 2>&1 | Write-Host
    $uploadExit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"

    if ($uploadExit -ne 0) {
        Write-Host "[$year] WARNING: immich-go reported $uploadExit error(s). Continuing anyway (--on-errors continue)." -ForegroundColor Red
    }

    Write-Host "[$year] Upload complete. Cleaning up temp files..." -ForegroundColor Green
    Remove-Item $yearTempPath -Recurse -Force

    # Mark year as done
    $year | Out-File -Append -FilePath $DoneFile
    Write-Host "[$year] Done!" -ForegroundColor Green
    Write-Host ""
}

Write-Host ""
Write-Host "=== Migration complete! ===" -ForegroundColor Cyan
Write-Host "All years processed. You can delete the 'transfers/' prefix from S3 when ready."
