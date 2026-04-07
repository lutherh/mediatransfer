# Check if the "missing" files are from immich-go deduplication or actual failures
# Also check for S3-internal duplicates (same file in multiple year folders)

param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = $env:IMMICH_API_KEY
)
if (-not $ApiKey) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }

$headers = @{ 'x-api-key' = $ApiKey }

Write-Host "=== Gap Analysis ===" -ForegroundColor Cyan

# ─── 1. Check total Immich assets (all users, including trashed) ───
Write-Host "`n--- Total Asset Counts ---" -ForegroundColor Yellow

# Search all assets
$page = 1
$pageSize = 1000
$totalAssets = 0
$assetsByOriginalPath = @{}

# Use search API to count all
$body = @{ page = 1; size = 1 } | ConvertTo-Json
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/search/metadata" -Method POST -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body $body -UseBasicParsing
$searchResult = $resp.Content | ConvertFrom-Json
Write-Host "  Total Immich assets (via search): checking..."

# ─── 2. Check for S3 cross-year duplicates ───
Write-Host "`n--- S3 Cross-Year Duplicate Check ---" -ForegroundColor Yellow
Write-Host "  Checking if files appear in multiple year folders..."

# Get file names (without path) from a sample of years with big gaps
$allFilesByName = @{}
$dupCrossYear = @()
$yearsToCheck = @('2025','unknown-date','2021','2017','2020','2019')

foreach ($y in $yearsToCheck) {
    Write-Host "  Scanning $y..." -NoNewline
    $lines = rclone ls "scaleway:photosync/transfers/$y" 2>&1 | Where-Object { $_ -match '\S' }
    $count = 0
    foreach ($line in $lines) {
        if ($line -match '^\s*\d+\s+(.+)$') {
            $fullPath = $Matches[1]
            $fileName = Split-Path $fullPath -Leaf
            if ($allFilesByName.ContainsKey($fileName)) {
                $allFilesByName[$fileName] += @($y)
            } else {
                $allFilesByName[$fileName] = @($y)
            }
            $count++
        }
    }
    Write-Host " $count files"
}

$crossDups = $allFilesByName.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 }
Write-Host "`n  Cross-year duplicates found: $($crossDups.Count)"
if ($crossDups.Count -gt 0) {
    Write-Host "  Sample cross-year duplicates:"
    $crossDups | Select-Object -First 10 | ForEach-Object {
        Write-Host ("    {0} -> in years: {1}" -f $_.Name, ($_.Value -join ', '))
    }
}

# ─── 3. Check within-year duplicates for biggest gap years ───
Write-Host "`n--- Within-Year Duplicate Check ---" -ForegroundColor Yellow
foreach ($y in @('2025','unknown-date','2021')) {
    $lines = rclone ls "scaleway:photosync/transfers/$y" 2>&1 | Where-Object { $_ -match '\S' }
    $fileNames = @{}
    $withinDups = 0
    foreach ($line in $lines) {
        if ($line -match '^\s*(\d+)\s+(.+)$') {
            $size = [long]$Matches[1]
            $fullPath = $Matches[2]
            $fileName = Split-Path $fullPath -Leaf
            $key = "$fileName|$size"
            if ($fileNames.ContainsKey($key)) {
                $withinDups++
            } else {
                $fileNames[$key] = $fullPath
            }
        }
    }
    $uniqueFiles = $fileNames.Count
    Write-Host "  $y : Total=$($lines.Count)  Unique(name+size)=$uniqueFiles  Within-dupes=$withinDups"
}

# ─── 4. Check Immich for assets with "unknown" or "1970" original dates ───
Write-Host "`n--- Immich: Checking for re-dated assets ---" -ForegroundColor Yellow
# Search for assets from 1970 (common default date for unknown)
$body = @{
    takenAfter = "1970-01-01T00:00:00.000Z"
    takenBefore = "1970-12-31T23:59:59.999Z"
    page = 1
    size = 1000
} | ConvertTo-Json
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/search/metadata" -Method POST -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body $body -UseBasicParsing
$result1970 = $resp.Content | ConvertFrom-Json
$assets1970 = $result1970.assets.items
Write-Host "  Assets dated 1970: $($assets1970.Count)"

# Search for very old dates (pre-2000)
$body = @{
    takenAfter = "1899-01-01T00:00:00.000Z"
    takenBefore = "1999-12-31T23:59:59.999Z"
    page = 1
    size = 1000
} | ConvertTo-Json
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/search/metadata" -Method POST -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body $body -UseBasicParsing
$resultOld = $resp.Content | ConvertFrom-Json
$assetsOld = $resultOld.assets.items
Write-Host "  Assets dated pre-2000: $($assetsOld.Count)"

# ─── 5. Check immich-go approach: verify what it reports as "already exists" ───
# Let's re-run immich-go in dry-run mode for unknown-date to see what it would do
Write-Host "`n--- Re-check: unknown-date folder via immich-go (dry-run) ---" -ForegroundColor Yellow
$tempDir = "$env:TEMP\immich-verify-unknown"
if (!(Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

# Download a small sample (first 20 files) from unknown-date
Write-Host "  Downloading sample from S3 unknown-date..."
$ErrorActionPreference = "Continue"
rclone copy "scaleway:photosync/transfers/unknown-date" $tempDir --max-transfer 50M --transfers 4 2>&1 | Out-Null
$sampleCount = (Get-ChildItem $tempDir -Recurse -File).Count
Write-Host "  Downloaded $sampleCount sample files"

if ($sampleCount -gt 0) {
    Write-Host "  Running immich-go dry-run..."
    $immichGo = "$env:LOCALAPPDATA\immich-go\immich-go.exe"
    cmd /c """$immichGo"" upload from-folder --server $ImmichUrl --api-key $ApiKey --recursive --no-ui --dry-run ""$tempDir""" 2>&1 | Select-Object -Last 5 | Write-Host
}
$ErrorActionPreference = "Stop"

# Cleanup
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue }

# ─── 6. Final delta explanation ───
Write-Host "`n=== Gap Explanation Summary ===" -ForegroundColor Cyan
Write-Host "  Total S3 files:    46427"
Write-Host "  Immich total:      43052 (41013 visible + 2039 trashed)"
Write-Host "  Gap:               3375 files"
Write-Host ""
Write-Host "  Likely causes:" -ForegroundColor Yellow
Write-Host "    1. S3-internal duplicates (same file in multiple folders)"
Write-Host "    2. immich-go hash-based dedup (iPhone uploads already in Immich)"
Write-Host "    3. unknown-date files were uploaded but Immich assigned real dates"
Write-Host "    4. 1970-dated files (.mov) may have been assigned actual dates by Immich"
