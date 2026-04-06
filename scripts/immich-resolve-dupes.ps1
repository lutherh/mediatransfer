<#
.SYNOPSIS
  Resolve Immich duplicate groups by trashing lower-quality variants.
  Uses Immich's own suggestedKeepAssetIds + filename pattern analysis.

.DESCRIPTION
  Phase 1: Auto-resolve groups where filenames indicate clear variants
           (e.g., photo.jpg + photo-edited.jpg + photo_1_.jpg)
  Phase 2: Leave ambiguous groups for manual review in the Immich UI.

  All trashed assets go to Immich's trash (recoverable for 30 days).
  Nothing is permanently deleted.

.PARAMETER DryRun
  When true (default), only logs what would be done without making changes.

.PARAMETER ImmichUrl
  Immich server URL.

.PARAMETER ApiKey
  Immich API key.

.PARAMETER BatchSize
  Number of groups to resolve per API call (max 100).
#>
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

# ── Fetch all duplicate groups ──
Write-Host "Fetching duplicate groups from Immich..." -ForegroundColor Cyan
$resp = Invoke-WebRequest -Uri "$ImmichUrl/api/duplicates" -Headers $headers -UseBasicParsing
$dupes = $resp.Content | ConvertFrom-Json

Write-Host "Found $($dupes.Count) duplicate groups." -ForegroundColor Yellow
if ($dupes.Count -eq 0) {
    Write-Host "No duplicates to resolve." -ForegroundColor Green
    exit 0
}

# ── Helper: strip variant suffixes to find the "base" name ──
function Get-BaseName {
    param([string]$filename)
    # Remove extension
    $name = [System.IO.Path]::GetFileNameWithoutExtension($filename)
    # Strip common Google Photos variant patterns:
    #   -edited, _1_, _2_, (1), (2), -EFFECTS, -ANIMATION, -COLLAGE, -PANO
    $name = $name -replace '-edited$', ''
    $name = $name -replace '-EFFECTS$', ''
    $name = $name -replace '-ANIMATION$', ''
    $name = $name -replace '-COLLAGE$', ''
    $name = $name -replace '-PANO$', ''
    $name = $name -replace '-COVER$', ''
    $name = $name -replace '_\d+_$', ''         # _1_, _2_
    $name = $name -replace '\(\d+\)$', ''       # (1), (2)
    $name = $name -replace '\s+$', ''           # trailing spaces
    return $name
}

# ── Classify each group ──
$autoResolve = @()
$manualReview = @()
$stats = @{
    totalGroups      = $dupes.Count
    autoResolvable   = 0
    manualReview     = 0
    assetsToTrash    = 0
    bytesToFree      = 0
}

foreach ($group in $dupes) {
    $assets = $group.assets
    $suggestedKeep = $group.suggestedKeepAssetIds

    # Get all base names
    $baseNames = @()
    foreach ($a in $assets) {
        $baseNames += Get-BaseName $a.originalFileName
    }
    $uniqueBaseNames = $baseNames | Sort-Object -Unique

    # Check if this is a recognizable variant group
    $isVariantGroup = $false

    # Pattern 1: All assets share the same base name (e.g., photo.jpg + photo-edited.jpg)
    if ($uniqueBaseNames.Count -eq 1) {
        $isVariantGroup = $true
    }

    # Pattern 2: Some names contain "-edited" or "_N_" suffix of another
    if (-not $isVariantGroup) {
        $hasEditedVariant = $false
        $hasNumberedVariant = $false
        foreach ($a in $assets) {
            $fn = $a.originalFileName
            if ($fn -match '-edited\.' -or $fn -match '-EFFECTS\.' -or $fn -match '-ANIMATION\.') {
                $hasEditedVariant = $true
            }
            if ($fn -match '_\d+_\.') {
                $hasNumberedVariant = $true
            }
        }
        if ($hasEditedVariant -or $hasNumberedVariant) {
            $isVariantGroup = $true
        }
    }

    if ($isVariantGroup -and $suggestedKeep.Count -gt 0) {
        # Use Immich's suggestion for which to keep
        $keepIds = [System.Collections.Generic.List[string]]::new()
        $trashIds = [System.Collections.Generic.List[string]]::new()

        foreach ($a in $assets) {
            if ($suggestedKeep -contains $a.id) {
                $keepIds.Add($a.id)
            } else {
                $trashIds.Add($a.id)
            }
        }

        # Safety: always keep at least one
        if ($keepIds.Count -eq 0) {
            # Fall back: keep the largest file
            $sorted = $assets | Sort-Object { $_.exifInfo.fileSizeInByte } -Descending
            $keepIds.Add($sorted[0].id)
            $trashIds = [System.Collections.Generic.List[string]]::new()
            for ($i = 1; $i -lt $sorted.Count; $i++) {
                $trashIds.Add($sorted[$i].id)
            }
        }

        if ($trashIds.Count -gt 0) {
            $autoResolve += @{
                duplicateId  = $group.duplicateId
                keepAssetIds = $keepIds.ToArray()
                trashAssetIds = $trashIds.ToArray()
                assets       = $assets
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
        } else {
            $manualReview += $group
            $stats.manualReview++
        }
    } else {
        $manualReview += $group
        $stats.manualReview++
    }
}

# ── Report ──
Write-Host ""
Write-Host "=== Duplicate Resolution Plan ===" -ForegroundColor Cyan
Write-Host "Total groups:          $($stats.totalGroups)"
Write-Host "Auto-resolvable:       $($stats.autoResolvable)" -ForegroundColor Green
Write-Host "Manual review needed:  $($stats.manualReview)" -ForegroundColor Yellow
Write-Host "Assets to trash:       $($stats.assetsToTrash)"
Write-Host "Space to reclaim:      $([math]::Round($stats.bytesToFree / 1MB, 1)) MB ($([math]::Round($stats.bytesToFree / 1GB, 2)) GB)"
Write-Host ""

# Show sample auto-resolve decisions
$sampleCount = [Math]::Min(10, $autoResolve.Count)
if ($sampleCount -gt 0) {
    Write-Host "--- Sample Auto-Resolve Decisions (first $sampleCount) ---" -ForegroundColor Yellow
    for ($i = 0; $i -lt $sampleCount; $i++) {
        $r = $autoResolve[$i]
        Write-Host "  Group: $($r.duplicateId)" -ForegroundColor Gray
        foreach ($a in $r.assets) {
            $sizeMB = if ($a.exifInfo.fileSizeInByte) { [math]::Round($a.exifInfo.fileSizeInByte / 1MB, 2) } else { "?" }
            $action = if ($r.keepAssetIds -contains $a.id) { "KEEP " } else { "TRASH" }
            $color = if ($action -eq "KEEP ") { "Green" } else { "Red" }
            Write-Host "    [$action] $($a.originalFileName) ($sizeMB MB)" -ForegroundColor $color
        }
    }
    Write-Host ""
}

# Show sample manual-review groups
$sampleManual = [Math]::Min(5, $manualReview.Count)
if ($sampleManual -gt 0) {
    Write-Host "--- Sample Manual Review Groups (first $sampleManual) ---" -ForegroundColor Yellow
    for ($i = 0; $i -lt $sampleManual; $i++) {
        $g = $manualReview[$i]
        Write-Host "  Group: $($g.duplicateId)" -ForegroundColor Gray
        foreach ($a in $g.assets) {
            $sizeMB = if ($a.exifInfo.fileSizeInByte) { [math]::Round($a.exifInfo.fileSizeInByte / 1MB, 2) } else { "?" }
            Write-Host "    $($a.originalFileName) ($sizeMB MB)" -ForegroundColor DarkYellow
        }
    }
    Write-Host ""
}

if ($DryRun) {
    Write-Host "DRY RUN — no changes made." -ForegroundColor Magenta
    Write-Host "Run with -Apply to execute." -ForegroundColor Magenta
    exit 0
}

# ── Execute: batch-resolve via POST /duplicates/resolve ──
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
        $result = Invoke-WebRequest -Uri "$ImmichUrl/api/duplicates/resolve" `
            -Method POST `
            -Headers $headers `
            -Body $body `
            -UseBasicParsing

        $parsed = $result.Content | ConvertFrom-Json
        $succeeded = ($parsed | Where-Object { $_.success -eq $true }).Count
        $failed = ($parsed | Where-Object { $_.success -ne $true }).Count
        $totalResolved += $succeeded
        $totalFailed += $failed

        $batchColor = if ($failed -gt 0) { "Yellow" } else { "Green" }
        Write-Host "  Batch $([math]::Floor($batch / $BatchSize) + 1): resolved $succeeded, failed $failed" -ForegroundColor $batchColor

        if ($failed -gt 0) {
            $parsed | Where-Object { $_.success -ne $true } | ForEach-Object {
                Write-Host "    FAILED: $($_.id) — $($_.error)" -ForegroundColor Red
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
Write-Host "Review remaining duplicates at: $ImmichUrl/duplicates" -ForegroundColor Gray
