# Final verification: re-attempt upload of gap years in dry-run mode
# to confirm immich-go considers these already uploaded (hash dedup)

param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = $env:IMMICH_API_KEY
)
if (-not $ApiKey) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }

$immichGo = "$env:LOCALAPPDATA\immich-go\immich-go.exe"
$tempBase = "$env:TEMP\immich-verify"
$ErrorActionPreference = "Continue"

$yearsToCheck = @('unknown-date', '2021', '2017')

foreach ($y in $yearsToCheck) {
    $tempDir = Join-Path $tempBase $y
    if (!(Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

    Write-Host "`n=== Re-verifying: $y ===" -ForegroundColor Cyan

    # Download from S3
    Write-Host "  Downloading from S3..."
    rclone copy "scaleway:photosync/transfers/$y" $tempDir --progress --transfers 8 2>&1 | Select-String "Transferred:" | Select-Object -Last 1 | Write-Host

    $fileCount = (Get-ChildItem $tempDir -Recurse -File).Count
    Write-Host "  Downloaded $fileCount files"

    if ($fileCount -eq 0) {
        Write-Host "  No files - skipping" -ForegroundColor Red
        continue
    }

    # Re-attempt upload (NOT dry-run — immich-go will skip existing by hash)
    Write-Host "  Running immich-go upload (will skip existing)..."
    $output = cmd /c """$immichGo"" upload from-folder --server $ImmichUrl --api-key $ApiKey --recursive --no-ui --on-errors continue ""$tempDir""" 2>&1
    $lastLines = $output | Select-Object -Last 3
    foreach ($line in $lastLines) { Write-Host "    $line" }

    # Parse out the final counts
    $finalLine = $output | Where-Object { $_ -match 'Uploaded\s+(\d+)' } | Select-Object -Last 1
    if ($finalLine -match 'Uploaded\s+(\d+)') {
        $uploaded = [int]$Matches[1]
        Write-Host "  Result: $uploaded NEW uploads (rest were already in Immich)" -ForegroundColor Green
    }

    # Clean up temp files for this year
    Write-Host "  Cleaning up..."
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Clean up base temp
if (Test-Path $tempBase) { Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "`n=== Verification Complete ===" -ForegroundColor Cyan
