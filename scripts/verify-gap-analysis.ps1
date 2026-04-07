# Deep-dive into the years with largest gaps
$years = @('2025','unknown-date','2021','2017','2024','2022','2023','2013','2014','2012','2020','2019','2018','2015','1970')

foreach ($y in $years) {
    Write-Host "`n--- $y ---" -ForegroundColor Yellow
    $lines = rclone ls "scaleway:photosync/transfers/$y" 2>&1 | Where-Object { $_ -match '\S' }

    $media = 0
    $nonMedia = 0
    $extensions = @{}
    $nonMediaFiles = @()

    foreach ($line in $lines) {
        if ($line -match '\.([^.\s]+)$') {
            $ext = $Matches[1].ToLower()
            if (-not $extensions.ContainsKey($ext)) { $extensions[$ext] = 0 }
            $extensions[$ext]++

            # JSON sidecars and other non-media
            if ($ext -in @('json','txt','html','xml','ini','log','csv','md','meta','srt','vtt')) {
                $nonMedia++
                if ($nonMediaFiles.Count -lt 5) {
                    $nonMediaFiles += $line.Trim()
                }
            } else {
                $media++
            }
        }
    }

    Write-Host "  Total files: $($lines.Count)  |  Media: $media  |  Non-media: $nonMedia"
    $extensions.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
        Write-Host ("    .{0,-10} {1,5}" -f $_.Name, $_.Value)
    }
    if ($nonMediaFiles.Count -gt 0) {
        Write-Host "  Sample non-media:"
        foreach ($f in $nonMediaFiles) {
            Write-Host "    $f"
        }
    }
}
