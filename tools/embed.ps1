$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$builder = [System.Text.StringBuilder]::new()
[void]$builder.AppendLine('/* Generated from web/ by tools/embed.ps1. */')
foreach ($name in @('index.html', 'client.js')) {
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root "web/$name"))
    $symbol = 'web_' + $name.Replace('.', '_')
    [void]$builder.AppendLine("static const unsigned char $symbol[] = {")
    for ($i = 0; $i -lt $bytes.Length; $i += 24) {
        $last = [Math]::Min($i + 23, $bytes.Length - 1)
        [void]$builder.AppendLine(($bytes[$i..$last] -join ',') + ',')
    }
    [void]$builder.AppendLine('0};')
    [void]$builder.AppendLine("static const unsigned int $($symbol)_len = $($bytes.Length);")
}
[System.IO.File]::WriteAllText((Join-Path $root 'src/web_assets.h'), $builder.ToString(), [System.Text.UTF8Encoding]::new($false))
