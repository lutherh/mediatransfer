# Smart verification: sample filenames from S3 gap years and search for them in Immich
# This avoids re-downloading GBs of data

param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = $env:IMMICH_API_KEY
)
if (-not $ApiKey) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }

$headers = @{
    'x-api-key' = $ApiKey
    'Content-Type' = 'application/json'
}

Write-Host "=== Smart Filename Verification ===" -ForegroundColor Cyan
Write-Host "Sampling filenames from S3 gap years and checking Immich..."
Write-Host ""

$yearsToCheck = @(
    @{ Year = 'unknown-date'; S3Count = 958; ImmichCount = 0; Delta = 958 },
    @{ Year = '2021'; S3Count = 3468; ImmichCount = 2930; Delta = 538 },
    @{ Year = '2025'; S3Count = 2019; ImmichCount = 741; Delta = 1278 },
    @{ Year = '2017'; S3Count = 4092; ImmichCount = 3894; Delta = 198 },
    @{ Year = '1970'; S3Count = 187; ImmichCount = 0; Delta = 187 },
    @{ Year = '2020'; S3Count = 3414; ImmichCount = 3346; Delta = 68 }
)

foreach ($info in $yearsToCheck) {
    $y = $info.Year
    Write-Host "--- $y (S3: $($info.S3Count), Immich: $($info.ImmichCount), Delta: $($info.Delta)) ---" -ForegroundColor Yellow

    # Get file list from S3
    $s3Lines = rclone ls "scaleway:photosync/transfers/$y" 2>&1 | Where-Object { $_ -match '\S' }

    # Extract filenames
    $s3Files = @()
    foreach ($line in $s3Lines) {
        if ($line -match '^\s*(\d+)\s+(.+)$') {
            $fileName = Split-Path $Matches[2] -Leaf
            $s3Files += @{ Name = $fileName; Size = [long]$Matches[1] }
        }
    }

    # Sample: take 30 random files (or all if fewer)
    $sampleSize = [math]::Min(30, $s3Files.Count)
    $sample = $s3Files | Get-Random -Count $sampleSize

    $found = 0
    $notFound = 0
    $notFoundFiles = @()

    foreach ($f in $sample) {
        # Search Immich for this filename
        $body = @{
            originalFileName = $f.Name
            page = 1
            size = 5
        } | ConvertTo-Json

        try {
            $resp = Invoke-WebRequest -Uri "$ImmichUrl/api/search/metadata" -Method POST -Headers $headers -Body $body -UseBasicParsing
            $result = $resp.Content | ConvertFrom-Json
            $assets = $result.assets.items

            if ($assets.Count -gt 0) {
                $found++
            } else {
                $notFound++
                if ($notFoundFiles.Count -lt 5) {
                    $notFoundFiles += "$($f.Name) ($([math]::Round($f.Size / 1MB, 2)) MB)"
                }
            }
        } catch {
            $notFound++
        }
    }

    $foundPct = [math]::Round(($found / $sampleSize) * 100, 1)
    $color = "Green"
    if ($foundPct -lt 80) { $color = "Red" }
    elseif ($foundPct -lt 95) { $color = "Yellow" }

    Write-Host "  Sampled $sampleSize files: $found found ($foundPct%), $notFound not found" -ForegroundColor $color
    if ($notFoundFiles.Count -gt 0) {
        Write-Host "  Not found samples:"
        foreach ($nf in $notFoundFiles) {
            Write-Host "    - $nf"
        }
    }
}

# ─── Also do a full check on unknown-date (958 files, all "missing") ───
Write-Host "`n--- FULL CHECK: unknown-date (all 958 files) ---" -ForegroundColor Cyan
$s3Lines = rclone ls "scaleway:photosync/transfers/unknown-date" 2>&1 | Where-Object { $_ -match '\S' }
$allFiles = @()
foreach ($line in $s3Lines) {
    if ($line -match '^\s*(\d+)\s+(.+)$') {
        $allFiles += @{ Name = (Split-Path $Matches[2] -Leaf); Size = [long]$Matches[1]; Path = $Matches[2] }
    }
}

$foundCount = 0
$missingCount = 0
$missingFiles = @()
$i = 0

foreach ($f in $allFiles) {
    $i++
    if ($i % 100 -eq 0) { Write-Host "  Checked $i / $($allFiles.Count)..." }

    $body = @{
        originalFileName = $f.Name
        page = 1
        size = 5
    } | ConvertTo-Json

    try {
        $resp = Invoke-WebRequest -Uri "$ImmichUrl/api/search/metadata" -Method POST -Headers $headers -Body $body -UseBasicParsing
        $result = $resp.Content | ConvertFrom-Json
        $assets = $result.assets.items

        if ($assets.Count -gt 0) {
            $foundCount++
        } else {
            $missingCount++
            $missingFiles += "$($f.Path) ($([math]::Round($f.Size / 1MB, 2)) MB)"
        }
    } catch {
        $missingCount++
        $missingFiles += "$($f.Path) (ERROR)"
    }
}

Write-Host ""
Write-Host "  unknown-date full check: $foundCount found, $missingCount truly missing" -ForegroundColor Cyan

if ($missingCount -gt 0) {
    Write-Host "`n  Truly missing files (first 20):" -ForegroundColor Red
    $missingFiles | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "  If found% is high across gap years, the delta is explained by:"
Write-Host "    - immich-go hashed and skipped S3 duplicates"
Write-Host "    - Immich re-dated files to correct EXIF years"
Write-Host "    - All media is safely in Immich"
