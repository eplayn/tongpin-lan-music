param([switch]$Force)
$ErrorActionPreference='Stop'
$data=Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$pfx=Join-Path $data 'https.pfx'
if((Test-Path -LiteralPath $pfx) -and -not $Force){Write-Host 'HTTPS certificate already prepared.';exit 0}
# Generate in memory; only project files are written. No certificate-store changes.
$rsa=[Security.Cryptography.RSACng]::new(2048)
$request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Tongpin LAN Music',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost');$san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
$ips=[Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {$_.OperationalStatus -eq 'Up'} | ForEach-Object {$_.GetIPProperties().UnicastAddresses} | Where-Object {$_.Address.AddressFamily -eq 'InterNetwork' -and -not [Net.IPAddress]::IsLoopback($_.Address)} | ForEach-Object {$_.Address} | Sort-Object -Unique
foreach($ip in $ips){$san.AddIpAddress($ip)}
$request.CertificateExtensions.Add($san.Build())
$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
$usage=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage,$true))
$oids=[Security.Cryptography.OidCollection]::new();$null=$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
$cert=$request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1),[DateTimeOffset]::Now.AddYears(1))
[IO.File]::WriteAllBytes($pfx,$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'Tongpin-LAN.cer'),$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
$hasher=[Security.Cryptography.SHA256]::Create()
$fingerprint=($hasher.ComputeHash($cert.RawData)|ForEach-Object {$_.ToString('X2')}) -join ':'
$hasher.Dispose()
[pscustomobject]@{subject=$cert.Subject;expires=$cert.NotAfter.ToString('o');addresses=@($ips|ForEach-Object {$_.ToString()});sha256=$fingerprint}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $data 'https-info.json') -Encoding utf8
$cert.Dispose();$rsa.Dispose()
Write-Host 'Prepared HTTPS certificate in project. No certificate was installed.'
Write-Host 'Another Windows source needs to trust Tongpin-LAN.cer in Current User / Trusted Root Certification Authorities.'
Write-Host "SHA256: $fingerprint"
