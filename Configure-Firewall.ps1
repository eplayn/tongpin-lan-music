param([int]$Port=8877)
$ErrorActionPreference='Stop'
$node=Join-Path $PSScriptRoot 'runtime\node.exe'
if(-not(Test-Path -LiteralPath $node)){$node=(Get-Command node.exe -ErrorAction Stop).Source}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $worker=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Port '+$Port) -Wait -PassThru
 if($worker.ExitCode -ne 0){throw 'Firewall setup failed or cancelled.'};return
}
$hash=[Security.Cryptography.SHA256]::Create()
$suffix=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($node.ToLowerInvariant())))).Replace('-','').Substring(0,12)
$hash.Dispose()
foreach($p in @($Port,($Port+1))){
 $name="Tongpin-Portable-$suffix-$p"
 if(-not(Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue)){
  New-NetFirewallRule -Name $name -DisplayName "Tongpin portable LAN $p" -Direction Inbound -Action Allow -Program $node -Protocol TCP -LocalPort $p -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null
 }
}
Write-Host 'LAN access enabled on Private/Domain networks. Set your trusted home network to Private in Windows settings.'
