<#
.SYNOPSIS
  Analyze Immich duplicates — classify exact vs visual, estimate savings.
#>
param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = "***REMOVED***"
)

$headers = @{ "x-api-key" = $ApiKey }
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/duplicates" -Headers $headers -UseBasicParsing
$dupes = $resp.Content | ConvertFrom-Json

Write-Host "=== Immich Duplicate Analysis ===" -ForegroundColor Cyan
Write-Host "Total duplicate groups: $($dupes.Count)"

$exactDupes = 0
$visualOnly = 0
$totalExcessAssets = 0
$totalExcessBytes = 0
$groupSizes = @{}

foreach ($g in $dupes) {
    $checksums = @()
    $sizes = @()
    foreach ($a in $g.assets) {
        $checksums += $a.checksum
        if ($a.exifInfo -and $a.exifInfo.fileSizeInByte) {
            $sizes += $a.exifInfo.fileSizeInByte
        }
    }
    $uniqueChecksums = $checksums | Sort-Object -Unique
    if ($uniqueChecksums.Count -eq 1) {
        $exactDupes++
    } else {
        $visualOnly++
    }

    $assetCount = $g.assets.Count
    $totalExcessAssets += ($assetCount - 1)

    # Estimate bytes from excess assets (keep the largest, delete rest)
    $sortedSizes = $sizes | Sort-Object -Descending
    for ($i = 1; $i -lt $sortedSizes.Count; $i++) {
        $totalExcessBytes += $sortedSizes[$i]
    }

    $key = "$assetCount"
    if ($groupSizes.ContainsKey($key)) { $groupSizes[$key]++ } else { $groupSizes[$key] = 1 }
}

Write-Host ""
Write-Host "--- Classification ---" -ForegroundColor Yellow
Write-Host "Exact duplicates (same checksum):     $exactDupes"
Write-Host "Visual duplicates (similar, diff file): $visualOnly"
Write-Host ""
Write-Host "--- Impact ---" -ForegroundColor Yellow
Write-Host "Total excess assets to remove: $totalExcessAssets"
Write-Host "Estimated space savings:       $([math]::Round($totalExcessBytes / 1MB, 1)) MB ($([math]::Round($totalExcessBytes / 1GB, 2)) GB)"
Write-Host ""
Write-Host "--- Group Size Distribution ---" -ForegroundColor Yellow
$groupSizes.GetEnumerator() | Sort-Object { [int]$_.Name } | ForEach-Object {
    Write-Host "  $($_.Name) assets per group: $($_.Value) groups"
}

# Show a few sample exact dupe groups
Write-Host ""
Write-Host "--- Sample Exact Duplicate Groups (first 5) ---" -ForegroundColor Yellow
$shown = 0
foreach ($g in $dupes) {
    if ($shown -ge 5) { break }
    $checksums = @()
    foreach ($a in $g.assets) { $checksums += $a.checksum }
    $uniqueChecksums = $checksums | Sort-Object -Unique
    if ($uniqueChecksums.Count -eq 1) {
        $shown++
        Write-Host "  Group: $($g.duplicateId)" -ForegroundColor Gray
        foreach ($a in $g.assets) {
            $sizeMB = if ($a.exifInfo.fileSizeInByte) { [math]::Round($a.exifInfo.fileSizeInByte / 1MB, 2) } else { "?" }
            Write-Host "    $($a.originalFileName) | $sizeMB MB | $($a.fileCreatedAt)"
        }
    }
}

# Show a few sample visual dupe groups
Write-Host ""
Write-Host "--- Sample Visual Duplicate Groups (first 5) ---" -ForegroundColor Yellow
$shown = 0
foreach ($g in $dupes) {
    if ($shown -ge 5) { break }
    $checksums = @()
    foreach ($a in $g.assets) { $checksums += $a.checksum }
    $uniqueChecksums = $checksums | Sort-Object -Unique
    if ($uniqueChecksums.Count -gt 1) {
        $shown++
        Write-Host "  Group: $($g.duplicateId)" -ForegroundColor Gray
        foreach ($a in $g.assets) {
            $sizeMB = if ($a.exifInfo.fileSizeInByte) { [math]::Round($a.exifInfo.fileSizeInByte / 1MB, 2) } else { "?" }
            Write-Host "    $($a.originalFileName) | $sizeMB MB | checksum: $($a.checksum)"
        }
    }
}
