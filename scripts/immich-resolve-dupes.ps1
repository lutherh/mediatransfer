param(
    [switch]$Apply,
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = "***REMOVED***",
    [int]$BatchSize    = 50
)

$DryRun = -not $Apply
$headers = @{
    "x-api-key"    = $ApiKey
    "Content-Type" = "application/json"
}

Write-Host "Fetching duplicate groups from Immich..." -ForegroundColor Cyan
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/duplicates" -Headers $headers -UseBasicParsing
$dupes = $resp.Content | ConvertFrom-Json

Write-Host "Found $($dupes.Count) duplicate groups." -ForegroundColor Yellow
if ($dupes.Count -eq 0) {
    Write-Host "No duplicates to resolve." -ForegroundColor Green
    exit 0
}

function Get-BaseName {
    param([string]$filename)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($filename)
    $name = $name -replace '-edited$', ''
    $name = $name -replace '-EFFECTS$', ''
    $name = $name -replace '-ANIMATION$', ''
    $name = $name -replace '-COLLAGE$', ''
    $name = $name -replace '-PANO$', ''
    $name = $name -replace '-COVER$', ''
    $name = $name -replace '_\d+_$', ''
    $name = $name -replace '\(\d+\)$', ''
    $name = $name -replace '\s+$', ''
    return $name
}

function Test-IsVariantGroup {
    param($assets)

    # Pattern 1: Any file has an -edited, -EFFECTS, _N_ suffix
    foreach ($a in $assets) {
        $fn = $a.originalFileName
        if ($fn -match '-edited\.' -or $fn -match '-EFFECTS\.' -or $fn -match '-ANIMATION\.' -or $fn -match '-COLLAGE\.' -or $fn -match '_\d+_\.') {
            return $true
        }
    }

    # Pattern 2: All base names match after stripping suffixes
    $baseNames = @()
    foreach ($a in $assets) {
        $baseNames += Get-BaseName $a.originalFileName
    }
    $unique = $baseNames | Sort-Object -Unique
    if ($unique.Count -eq 1) {
        return $true
    }

    # Pattern 3: All assets share the same capture timestamp
    $dates = @()
    foreach ($a in $assets) {
        if ($a.fileCreatedAt) {
            $dates += $a.fileCreatedAt.Substring(0, 19)
        }
    }
    $uniqueDates = $dates | Sort-Object -Unique
    if ($uniqueDates.Count -eq 1 -and $dates.Count -eq $assets.Count) {
        return $true
    }

    # Pattern 4: filenames differ only by formatting (e.g. 2012-04-06_18.48.20 vs 20120406_184820)
    # Extract digits-only from filenames and compare
    $digitPatterns = @()
    foreach ($a in $assets) {
        $nameOnly = [System.IO.Path]::GetFileNameWithoutExtension($a.originalFileName)
        $nameOnly = $nameOnly -replace '-edited$', ''
        $digits = $nameOnly -replace '[^0-9]', ''
        if ($digits.Length -ge 8) {
            $digitPatterns += $digits.Substring(0, [Math]::Min(14, $digits.Length))
        }
    }
    $uniqueDigits = $digitPatterns | Sort-Object -Unique
    if ($uniqueDigits.Count -eq 1 -and $digitPatterns.Count -eq $assets.Count) {
        return $true
    }

    return $false
}

$autoResolve = @()
$manualReview = @()
$stats = @{
    totalGroups    = $dupes.Count
    autoResolvable = 0
    manualReview   = 0
    assetsToTrash  = 0
    bytesToFree    = 0
}

foreach ($group in $dupes) {
    $assets = $group.assets

    $isVariantGroup = Test-IsVariantGroup $assets

    if ($isVariantGroup) {
        # Pick the best asset: prefer the original (no -edited suffix), then largest file
        $keepIds = [System.Collections.Generic.List[string]]::new()
        $trashIds = [System.Collections.Generic.List[string]]::new()

        # Sort: non-edited first, then by file size descending
        $sorted = $assets | Sort-Object @{
            Expression = {
                $fn = $_.originalFileName
                if ($fn -match '-edited\.' -or $fn -match '-EFFECTS\.' -or $fn -match '-ANIMATION\.' -or $fn -match '-COLLAGE\.' -or $fn -match '_\d+_\.') { 1 } else { 0 }
            }
        }, @{
            Expression = { $_.exifInfo.fileSizeInByte }
            Descending = $true
        }

        # Keep the first (best) asset, trash the rest
        $keepIds.Add($sorted[0].id)
        for ($i = 1; $i -lt $sorted.Count; $i++) {
            $trashIds.Add($sorted[$i].id)
        }

        if ($trashIds.Count -gt 0) {
            $autoResolve += @{
                duplicateId   = $group.duplicateId
                keepAssetIds  = $keepIds.ToArray()
                trashAssetIds = $trashIds.ToArray()
                assets        = $assets
            }
            $stats.autoResolvable++
            $stats.assetsToTrash += $trashIds.Count

            foreach ($a in $assets) {
                if ($trashIds -contains $a.id) {
                    if ($a.exifInfo -and $a.exifInfo.fileSizeInByte) {
                        $stats.bytesToFree += $a.exifInfo.fileSizeInByte
                    }
                }
            }
        }
        else {
            $manualReview += $group
            $stats.manualReview++
        }
    }
    else {
        $manualReview += $group
        $stats.manualReview++
    }
}

Write-Host ""
Write-Host "=== Duplicate Resolution Plan ===" -ForegroundColor Cyan
Write-Host "Total groups:          $($stats.totalGroups)"
Write-Host "Auto-resolvable:       $($stats.autoResolvable)" -ForegroundColor Green
Write-Host "Manual review needed:  $($stats.manualReview)" -ForegroundColor Yellow
Write-Host "Assets to trash:       $($stats.assetsToTrash)"
$mbFree = [math]::Round($stats.bytesToFree / 1MB, 1)
$gbFree = [math]::Round($stats.bytesToFree / 1GB, 2)
Write-Host "Space to reclaim:      $mbFree MB ($gbFree GB)"
Write-Host ""

$sampleCount = [Math]::Min(10, $autoResolve.Count)
if ($sampleCount -gt 0) {
    Write-Host "--- Sample Auto-Resolve Decisions (first $sampleCount) ---" -ForegroundColor Yellow
    for ($i = 0; $i -lt $sampleCount; $i++) {
        $r = $autoResolve[$i]
        Write-Host "  Group: $($r.duplicateId)" -ForegroundColor Gray
        foreach ($a in $r.assets) {
            if ($a.exifInfo.fileSizeInByte) {
                $sizeMB = [math]::Round($a.exifInfo.fileSizeInByte / 1MB, 2)
            }
            else {
                $sizeMB = "?"
            }
            if ($r.keepAssetIds -contains $a.id) {
                Write-Host "    [KEEP ] $($a.originalFileName) ($sizeMB MB)" -ForegroundColor Green
            }
            else {
                Write-Host "    [TRASH] $($a.originalFileName) ($sizeMB MB)" -ForegroundColor Red
            }
        }
    }
    Write-Host ""
}

$sampleManual = [Math]::Min(5, $manualReview.Count)
if ($sampleManual -gt 0) {
    Write-Host "--- Sample Manual Review Groups (first $sampleManual) ---" -ForegroundColor Yellow
    for ($i = 0; $i -lt $sampleManual; $i++) {
        $g = $manualReview[$i]
        Write-Host "  Group: $($g.duplicateId)" -ForegroundColor Gray
        foreach ($a in $g.assets) {
            if ($a.exifInfo.fileSizeInByte) {
                $sizeMB = [math]::Round($a.exifInfo.fileSizeInByte / 1MB, 2)
            }
            else {
                $sizeMB = "?"
            }
            Write-Host "    $($a.originalFileName) ($sizeMB MB)" -ForegroundColor DarkYellow
        }
    }
    Write-Host ""
}

if ($DryRun) {
    Write-Host "DRY RUN - no changes made." -ForegroundColor Magenta
    Write-Host "Run with -Apply to execute." -ForegroundColor Magenta
    exit 0
}

Write-Host "Executing duplicate resolution..." -ForegroundColor Cyan
$totalResolved = 0
$totalFailed = 0

for ($batch = 0; $batch -lt $autoResolve.Count; $batch += $BatchSize) {
    $end = [Math]::Min($batch + $BatchSize, $autoResolve.Count)
    $batchItems = $autoResolve[$batch..($end - 1)]

    $groups = @()
    foreach ($item in $batchItems) {
        $groups += @{
            duplicateId   = $item.duplicateId
            keepAssetIds  = $item.keepAssetIds
            trashAssetIds = $item.trashAssetIds
        }
    }

    $body = @{ groups = $groups } | ConvertTo-Json -Depth 5 -Compress

    try {
        $result = Invoke-WebRequest -Uri "$ImmichUrl/api/duplicates/resolve" -Method POST -Headers $headers -Body $body -UseBasicParsing

        $parsed = $result.Content | ConvertFrom-Json
        $succeeded = ($parsed | Where-Object { $_.success -eq $true }).Count
        $failed = ($parsed | Where-Object { $_.success -ne $true }).Count
        $totalResolved += $succeeded
        $totalFailed += $failed

        if ($failed -gt 0) { $batchColor = "Yellow" } else { $batchColor = "Green" }
        $batchNum = [math]::Floor($batch / $BatchSize) + 1
        Write-Host "  Batch ${batchNum}: resolved $succeeded, failed $failed" -ForegroundColor $batchColor

        if ($failed -gt 0) {
            $parsed | Where-Object { $_.success -ne $true } | ForEach-Object {
                Write-Host "    FAILED: $($_.id) - $($_.error)" -ForegroundColor Red
            }
        }
    }
    catch {
        Write-Host "  Batch failed: $($_.Exception.Message)" -ForegroundColor Red
        $totalFailed += $batchItems.Count
    }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "Resolved: $totalResolved groups"
if ($totalFailed -gt 0) {
    Write-Host "Failed:   $totalFailed groups" -ForegroundColor Red
}
Write-Host "Remaining for manual review: $($stats.manualReview) groups"
Write-Host ""
Write-Host "Trashed assets are recoverable for 30 days in Immich." -ForegroundColor Gray
$dupeUrl = "$ImmichUrl" + "/duplicates"
Write-Host "Review remaining duplicates at: $dupeUrl" -ForegroundColor Gray
