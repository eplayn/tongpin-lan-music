$ErrorActionPreference='Stop'
$statePath=Join-Path $PSScriptRoot 'data\server-state.json'
if(-not(Test-Path -LiteralPath $statePath)){Write-Host 'No saved music server process.';exit 0}
$saved=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($saved.pid)" -ErrorAction SilentlyContinue
if($p){
 if($p.Name -ne 'node.exe' -or -not $p.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))){throw 'Saved PID belongs to another process.'}
 $process=Get-Process -Id $saved.pid
 $expectedStart=[datetimeoffset]$saved.started
 if([Math]::Abs($process.StartTime.ToUniversalTime().Ticks-$expectedStart.UtcDateTime.Ticks) -gt 10000){throw 'Saved PID has been reused.'}
 Stop-Process -Id $saved.pid
 $process.WaitForExit(5000)|Out-Null
}
Remove-Item -LiteralPath $statePath
Write-Host 'Music server stopped.'
