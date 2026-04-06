$headers = @{ 'x-api-key' = '***REMOVED***' }

# Get server stats
$resp = Invoke-WebRequest -Uri 'http://localhost:2283/api/server/statistics' -Headers $headers -UseBasicParsing
$stats = $resp.Content | ConvertFrom-Json
Write-Host "=== Immich Server Statistics ==="
$stats.usageByUser | ForEach-Object {
    Write-Host "  User: $($_.userName) - Photos: $($_.photos) Videos: $($_.videos) Usage: $([math]::Round($_.usage / 1GB, 2)) GB"
}

# Get asset count by year using timeline buckets
Write-Host "`n=== Assets by Year ==="
$resp2 = Invoke-WebRequest -Uri 'http://localhost:2283/api/timeline/buckets?size=MONTH&isArchived=false' -Headers $headers -UseBasicParsing
$buckets = $resp2.Content | ConvertFrom-Json
$byYear = @{}
foreach ($b in $buckets) {
    $year = $b.timeBucket.Substring(0, 4)
    if (-not $byYear.ContainsKey($year)) { $byYear[$year] = 0 }
    $byYear[$year] += $b.count
}
$byYear.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  {0}: {1,6} assets" -f $_.Name, $_.Value)
}

# Count S3 files per year
Write-Host "`n=== S3 files by Year ==="
$years = @('2004','2005','2006','2007','2008','2009','2010','2011','2012','2013','2014','2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025')
foreach ($y in $years) {
    $count = (rclone ls "scaleway:photosync/transfers/$y" 2>&1 | Measure-Object -Line).Lines
    Write-Host ("  {0}: {1,6} files" -f $y, $count)
}
