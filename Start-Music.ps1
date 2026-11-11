param([int]$Port=8877)
$ErrorActionPreference='Stop'
$node=Join-Path $PSScriptRoot 'runtime\node.exe'
if(-not(Test-Path -LiteralPath $node)){$node=(Get-Command node.exe -ErrorAction Stop).Source}
$scriptPath=Join-Path $PSScriptRoot 'server.mjs'
$data=Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
if(-not(Test-Path (Join-Path $data 'live-buffer.json'))){[IO.File]::WriteAllText((Join-Path $data 'live-buffer.json'),'{"mode":"adaptive"}')}
if(-not(Test-Path -LiteralPath $node)){throw 'Please extract the complete ZIP first. runtime\node.exe is missing.'}
$statePath=Join-Path $data 'server-state.json'
if(Test-Path -LiteralPath $statePath){
 $saved=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
 $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$($saved.pid)" -ErrorAction SilentlyContinue
 if($existing -and $existing.ExecutablePath -eq $node -and $existing.CommandLine.Contains($scriptPath)){
  $health=Invoke-RestMethod "http://127.0.0.1:$($saved.port)/api/health" -TimeoutSec 3
  Write-Host "Already running: http://127.0.0.1:$($saved.port)/live/"
  return
 }
}
# Fail before creating a process if another server owns either port.
foreach($p in @($Port,($Port+1))){
 $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,$p)
 $probe.Server.ExclusiveAddressUse=$true
 try{$probe.Start()}catch{throw "Port $p is occupied. Stop the other server, or use Start-Music.ps1 -Port 8897."}finally{$probe.Stop()}
}
$ips=@([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {$_.OperationalStatus -eq 'Up'} | ForEach-Object {$_.GetIPProperties().UnicastAddresses} | Where-Object {$_.Address.AddressFamily -eq 'InterNetwork' -and -not [Net.IPAddress]::IsLoopback($_.Address)} | ForEach-Object {$_.Address.ToString()} | Sort-Object -Unique)
$infoPath=Join-Path $data 'https-info.json'
$renew=-not(Test-Path -LiteralPath (Join-Path $data 'https.pfx'))
if(-not $renew){
 try{
  $info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
  $renew=$info.computerName -ne $env:COMPUTERNAME -or ([datetime]$info.expires -lt (Get-Date).AddDays(7))
  foreach($ip in $ips){if($ip -notin @($info.addresses)){$renew=$true}}
 }catch{$renew=$true}
}
if($renew){
 & (Join-Path $PSScriptRoot 'Prepare-HTTPS.ps1') -Force
 $info=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
 $info | Add-Member -NotePropertyName computerName -NotePropertyValue $env:COMPUTERNAME -Force
 $info | ConvertTo-Json | Set-Content -LiteralPath $infoPath -Encoding utf8
 Write-Host 'New certificate generated. Remote source computers must trust the NEW Tongpin-LAN.cer.'
}
$process=Start-Process -FilePath $node -ArgumentList ('"'+$scriptPath+'" --port '+$Port) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'server.log') -RedirectStandardError (Join-Path $data 'server-error.log') -PassThru
[pscustomobject]@{pid=$process.Id;port=$Port;script=$scriptPath;started=$process.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $statePath -Encoding utf8
$ready=$false
for($i=0;$i -lt 40;$i++){
 $process.Refresh();if($process.HasExited){Get-Content (Join-Path $data 'server-error.log') -Tail 12;throw 'Server exited.'}
 try{$null=Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1;$ready=$true;break}catch{Start-Sleep -Milliseconds 250}
}
if(-not $ready){throw 'Server did not become ready. See data/server-error.log.'}
$status=Invoke-RestMethod "http://127.0.0.1:$Port/api/live/status"
Write-Host "LOCAL SOURCE: http://127.0.0.1:$Port/live/"
Write-Host 'LAN listeners:'; $status.urls.http | Where-Object {$_ -notmatch '127.0.0.1'} | ForEach-Object {Write-Host $_}
Write-Host 'LAN sources (trust certificate first):'; $status.urls.https | Where-Object {$_ -notmatch '127.0.0.1'} | ForEach-Object {Write-Host $_}
Write-Host 'Join -> Read devices -> CABLE Output + real speakers -> Take control -> Start system sharing.'
