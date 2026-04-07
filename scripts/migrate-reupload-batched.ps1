# Re-upload missing files using a subfolder-by-subfolder approach
# to stay within disk space limits. Each subfolder is downloaded,
# uploaded, then deleted before the next one starts.

param(
    [string]$ImmichUrl = "http://localhost:2283",
    [string]$ApiKey    = $env:IMMICH_API_KEY,
    [string]$S3Remote  = "scaleway:photosync/transfers",
    [string]$TempDir   = "$env:TEMP\immich-reup"
)
if (-not $ApiKey) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }

$immichGo = "$env:LOCALAPPDATA\immich-go\immich-go.exe"

# Years to re-upload, worst gaps first
$years = @('unknown-date', '2025', '2021', '2017', '2020', '2019', '2022', '2023', '2024')

# Track completed subfolder batches for resume
$doneFile = Join-Path $TempDir "reupload-done.txt"
if (!(Test-Path $TempDir)) { New-Item -ItemType Directory -Path $TempDir -Force | Out-Null }
$doneBatches = @()
if (Test-Path $doneFile) {
    $doneBatches = Get-Content $doneFile | Where-Object { $_.Trim() -ne "" }
}

Write-Host "=== Re-uploading missing files (subfolder batching) ===" -ForegroundColor Cyan
Write-Host "Available disk: $([math]::Round((Get-PSDrive C).Free / 1GB, 2)) GB"
Write-Host "Already completed batches: $($doneBatches.Count)"
Write-Host ""

$totalUploaded = 0
$totalSkipped = 0

foreach ($y in $years) {
    Write-Host "`n===== $y =====" -ForegroundColor Cyan

    # List subfolders in this year
    $subfolders = rclone lsd "$S3Remote/$y" 2>&1 | ForEach-Object {
        if ($_ -match '^\s*-?\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\-?\d+\s+(.+)\s*$') {
            $Matches[1].Trim()
        }
    } | Where-Object { $_ -ne "" }

    # Also check for root-level files (not in subfolders)
    $rootFiles = rclone ls "$S3Remote/$y" --max-depth 1 2>&1 | Where-Object { $_ -match '\S' }
    $hasRootFiles = $rootFiles.Count -gt 0

    if ($subfolders.Count -eq 0 -and -not $hasRootFiles) {
        Write-Host "  No subfolders or files found. Skipping." -ForegroundColor DarkGray
        continue
    }

    # Process root files first (if any)
    if ($hasRootFiles) {
        $batchKey = "$y/root"
        if ($doneBatches -contains $batchKey) {
            Write-Host "  [root files] Already done, skipping." -ForegroundColor DarkGray
        } else {
            Write-Host "  [root files] Downloading..." -ForegroundColor Yellow
            $batchDir = Join-Path $TempDir "$y-root"
            if (!(Test-Path $batchDir)) { New-Item -ItemType Directory -Path $batchDir -Force | Out-Null }

        $ErrorActionPreference = "Continue"
        rclone copy "$S3Remote/$y" $batchDir --max-depth 1 --transfers 4 --multi-thread-streams 0 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"

        $fileCount = (Get-ChildItem $batchDir -File -ErrorAction SilentlyContinue).Count
        if ($fileCount -gt 0) {
            Write-Host "  [root files] Uploading $fileCount files..." -ForegroundColor Yellow
            $ErrorActionPreference = "Continue"
            $output = cmd /c """$immichGo"" upload from-folder --server $ImmichUrl --api-key $ApiKey --recursive --no-ui --on-errors continue ""$batchDir""" 2>&1
            $ErrorActionPreference = "Stop"

            $finalLine = $output | Where-Object { $_ -match 'Uploaded\s+(\d+)' } | Select-Object -Last 1
            if ($finalLine -match 'Uploaded\s+(\d+)') {
                $uploaded = [int]$Matches[1]
                $totalUploaded += $uploaded
                Write-Host "  [root files] Uploaded $uploaded new files" -ForegroundColor Green
            }
        }
        Remove-Item $batchDir -Recurse -Force -ErrorAction SilentlyContinue
        $batchKey | Out-File -Append -FilePath $doneFile
        }
    }

    # Process each subfolder
    foreach ($sub in $subfolders) {
        $batchKey = "$y/$sub"
        if ($doneBatches -contains $batchKey) {
            Write-Host "  [$sub] Already done, skipping." -ForegroundColor DarkGray
            continue
        }

        # Check available space
        $freeGB = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
        if ($freeGB -lt 1) {
            Write-Host "  WARNING: Only $freeGB GB free! Skipping remaining. Re-run later." -ForegroundColor Red
            break
        }

        $batchDir = Join-Path $TempDir "$y-$($sub -replace '[^\w\-]', '_')"
        if (!(Test-Path $batchDir)) { New-Item -ItemType Directory -Path $batchDir -Force | Out-Null }

        Write-Host "  [$sub] Downloading..." -ForegroundColor DarkGray -NoNewline

        $ErrorActionPreference = "Continue"
        rclone copy "$S3Remote/$y/$sub" $batchDir --transfers 4 --multi-thread-streams 0 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"

        $fileCount = (Get-ChildItem $batchDir -Recurse -File -ErrorAction SilentlyContinue).Count
        $sizeMB = [math]::Round((Get-ChildItem $batchDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
        Write-Host " $fileCount files ($sizeMB MB)" -NoNewline

        if ($fileCount -eq 0) {
            Write-Host " (empty)" -ForegroundColor DarkGray
            Remove-Item $batchDir -Recurse -Force -ErrorAction SilentlyContinue
            continue
        }

        # Upload
        $ErrorActionPreference = "Continue"
        $output = cmd /c """$immichGo"" upload from-folder --server $ImmichUrl --api-key $ApiKey --folder-as-album FOLDER --recursive --no-ui --on-errors continue ""$batchDir""" 2>&1
        $ErrorActionPreference = "Stop"

        $finalLine = $output | Where-Object { $_ -match 'Uploaded\s+(\d+)' } | Select-Object -Last 1
        if ($finalLine -match 'Uploaded\s+(\d+)') {
            $uploaded = [int]$Matches[1]
            $totalUploaded += $uploaded
            if ($uploaded -gt 0) {
                Write-Host " -> $uploaded NEW" -ForegroundColor Green
            } else {
                Write-Host " -> all existed" -ForegroundColor DarkGray
            }
        } else {
            Write-Host " -> done" -ForegroundColor DarkGray
        }

        # Clean up immediately
        Remove-Item $batchDir -Recurse -Force -ErrorAction SilentlyContinue
        $batchKey | Out-File -Append -FilePath $doneFile
    }
}

# Final cleanup (keep the done file for resume)
Get-ChildItem $TempDir -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n=== Re-upload Complete ===" -ForegroundColor Cyan
Write-Host "  New files uploaded: $totalUploaded"
Write-Host "  Free disk: $([math]::Round((Get-PSDrive C).Free / 1GB, 2)) GB"
