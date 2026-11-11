param([ValidateSet('stable','minimum','100ms','adaptive')][string]$Mode='stable')
$ErrorActionPreference='Stop'
$settingsPath=Join-Path $PSScriptRoot 'data\live-buffer.json'
[IO.File]::WriteAllText($settingsPath,(@{mode=$Mode}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot 'Stop-Music.ps1')
& (Join-Path $PSScriptRoot 'Start-Music.ps1')
Write-Host "Buffer mode: $Mode. Refresh all listening pages, join again, then share CABLE."
