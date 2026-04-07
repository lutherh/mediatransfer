param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = $env:IMMICH_API_KEY
)
if (-not $ApiKey) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }

$headers = @{ 'x-api-key' = $ApiKey }

Write-Host "=== Deep Verification: S3 vs Immich ===" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Immich overall stats ───
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/server/statistics" -Headers $headers -UseBasicParsing
$stats = ($resp.Content | ConvertFrom-Json)
Write-Host "--- Immich Server Stats ---" -ForegroundColor Yellow
foreach ($u in $stats.usageByUser) {
    Write-Host ("  {0}: {1} photos, {2} videos, {3:N2} GB" -f $u.userName, $u.photos, $u.videos, ($u.usage / 1GB))
}

# ─── 2. Immich assets by year (timeline buckets) ───
Write-Host ""
Write-Host "--- Immich Assets by Year ---" -ForegroundColor Yellow
$resp2 = Invoke-WebRequest -Uri "$ImmichUrl/api/timeline/buckets?size=MONTH&isArchived=false" -Headers $headers -UseBasicParsing
$buckets = $resp2.Content | ConvertFrom-Json
$immichByYear = @{}
foreach ($b in $buckets) {
    $year = $b.timeBucket.Substring(0, 4)
    if (-not $immichByYear.ContainsKey($year)) { $immichByYear[$year] = 0 }
    $immichByYear[$year] += $b.count
}

# Also get trashed count
$resp3 = Invoke-WebRequest -Uri "$ImmichUrl/api/timeline/buckets?size=MONTH&isTrashed=true" -Headers $headers -UseBasicParsing
$trashedBuckets = $resp3.Content | ConvertFrom-Json
$trashedByYear = @{}
$totalTrashed = 0
foreach ($b in $trashedBuckets) {
    $year = $b.timeBucket.Substring(0, 4)
    if (-not $trashedByYear.ContainsKey($year)) { $trashedByYear[$year] = 0 }
    $trashedByYear[$year] += $b.count
    $totalTrashed += $b.count
}

# ─── 3. S3 file counts per year ───
Write-Host ""
Write-Host "--- S3 File Counts (may take a minute) ---" -ForegroundColor Yellow
$s3ByYear = @{}
$allYears = @('1899','1970','1979','1998','2000','2004','2005','2006','2007','2008','2009','2010','2011','2012','2013','2014','2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025','2026','unknown-date')

foreach ($y in $allYears) {
    $lines = rclone ls "scaleway:photosync/transfers/$y" 2>&1
    $count = ($lines | Where-Object { $_ -match '\S' } | Measure-Object).Count
    $s3ByYear[$y] = $count
}

# ─── 4. Comparison table ───
Write-Host ""
Write-Host "=== Year-by-Year Comparison ===" -ForegroundColor Cyan
Write-Host ("{0,-12} {1,8} {2,8} {3,8} {4,8} {5,8}" -f "Year", "S3", "Immich", "Trashed", "Total", "Delta")
Write-Host ("{0,-12} {1,8} {2,8} {3,8} {4,8} {5,8}" -f "----", "----", "------", "-------", "-----", "-----")

$totalS3 = 0
$totalImmich = 0
$totalImmichTrashed = 0
$totalDelta = 0

# Gather all years from both sources
$allCompareYears = ($s3ByYear.Keys + $immichByYear.Keys) | Sort-Object -Unique

foreach ($y in $allCompareYears) {
    $s3Count = 0
    if ($s3ByYear.ContainsKey($y)) { $s3Count = $s3ByYear[$y] }
    $immichCount = 0
    if ($immichByYear.ContainsKey($y)) { $immichCount = $immichByYear[$y] }
    $trashedCount = 0
    if ($trashedByYear.ContainsKey($y)) { $trashedCount = $trashedByYear[$y] }
    $totalInImmich = $immichCount + $trashedCount
    $delta = $s3Count - $totalInImmich

    $totalS3 += $s3Count
    $totalImmich += $immichCount
    $totalImmichTrashed += $trashedCount
    $totalDelta += $delta

    $color = "White"
    if ($delta -gt 0) { $color = "Red" }
    elseif ($delta -lt 0) { $color = "DarkYellow" }
    else { $color = "Green" }

    $line = "{0,-12} {1,8} {2,8} {3,8} {4,8} {5,8}" -f $y, $s3Count, $immichCount, $trashedCount, $totalInImmich, $delta
    Write-Host $line -ForegroundColor $color
}

Write-Host ("{0,-12} {1,8} {2,8} {3,8} {4,8} {5,8}" -f "----", "----", "------", "-------", "-----", "-----")
$line = "{0,-12} {1,8} {2,8} {3,8} {4,8} {5,8}" -f "TOTAL", $totalS3, $totalImmich, $totalImmichTrashed, ($totalImmich + $totalImmichTrashed), $totalDelta
Write-Host $line -ForegroundColor Cyan

# ─── 5. Immich-only assets (from iPhone, not in S3) ───
Write-Host ""
Write-Host "--- Immich-Only Assets (iPhone uploads, not from S3) ---" -ForegroundColor Yellow
$immichOnlyYears = $immichByYear.Keys | Where-Object { -not $s3ByYear.ContainsKey($_) -or $s3ByYear[$_] -eq 0 }
foreach ($y in ($immichOnlyYears | Sort-Object)) {
    Write-Host ("  {0}: {1} assets (iPhone/direct uploads)" -f $y, $immichByYear[$y])
}

# ─── 6. Check for S3 sidecar/json files that aren't real photos ───
Write-Host ""
Write-Host "--- S3 File Type Breakdown (sample: 2018) ---" -ForegroundColor Yellow
$sample = rclone ls "scaleway:photosync/transfers/2018" 2>&1 | Where-Object { $_ -match '\S' }
$extensions = @{}
foreach ($line in $sample) {
    if ($line -match '\.([^.\s]+)$') {
        $ext = $Matches[1].ToLower()
        if (-not $extensions.ContainsKey($ext)) { $extensions[$ext] = 0 }
        $extensions[$ext]++
    }
}
$extensions.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  .{0,-10} {1,6} files" -f $_.Name, $_.Value)
}

# ─── 7. Summary ───
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "  S3 total files:          $totalS3"
Write-Host "  Immich visible assets:   $totalImmich"
Write-Host "  Immich trashed assets:   $totalImmichTrashed"
Write-Host "  Immich total (incl trash): $($totalImmich + $totalImmichTrashed)"
Write-Host "  Delta (S3 - Immich):     $totalDelta"
Write-Host ""
if ($totalDelta -gt 0) {
    Write-Host "  NOTE: Positive delta means S3 has more files. This can be due to:" -ForegroundColor Yellow
    Write-Host "    - JSON sidecar files in S3 (not uploaded as assets)"
    Write-Host "    - Duplicate files in S3 that immich-go deduplicated"
    Write-Host "    - Upload failures (check immich-go logs)"
} elseif ($totalDelta -lt 0) {
    Write-Host "  NOTE: Negative delta means Immich has more. Likely from iPhone/direct uploads." -ForegroundColor DarkYellow
} else {
    Write-Host "  Perfect match!" -ForegroundColor Green
}
