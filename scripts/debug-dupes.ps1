if (-not $env:IMMICH_API_KEY) { Write-Error "IMMICH_API_KEY env var not set. Add it to .env or set it in your shell."; exit 1 }
$headers = @{ "x-api-key" = $env:IMMICH_API_KEY }
$resp = Invoke-WebRequest -Uri "http://localhost:2283/api/duplicates" -Headers $headers -UseBasicParsing
$dupes = $resp.Content | ConvertFrom-Json
$g = $dupes[0]

Write-Host "duplicateId: $($g.duplicateId)"
Write-Host "assets count: $($g.assets.Count)"
Write-Host "suggestedKeepAssetIds type: $($g.suggestedKeepAssetIds.GetType().FullName)"
Write-Host "suggestedKeepAssetIds count: $($g.suggestedKeepAssetIds.Count)"
Write-Host "suggestedKeepAssetIds value:"
$g.suggestedKeepAssetIds | ForEach-Object { Write-Host "  $_" }

# Test variant detection
foreach ($a in $g.assets) {
    $fn = $a.originalFileName
    Write-Host "  Asset: $fn | fileCreatedAt: $($a.fileCreatedAt)"
    Write-Host "    matches -edited: $($fn -match '-edited\.')"
    Write-Host "    matches _N_: $($fn -match '_\d+_\.')"
}
