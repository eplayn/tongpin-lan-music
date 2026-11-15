param([switch]$Test)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & "$PSScriptRoot/tools/embed.ps1"
    New-Item -ItemType Directory -Force dist,work/build | Out-Null
    $files = @('src/main.c','src/audio.c','src/server.c','src/sync.c','src/route.c','src/cable.c','src/calibrate.c','src/network_setup.c')
    & gcc -std=c11 -O2 tools/quiet_exec.c -municode -o tools/quiet_exec.exe
    if ($LASTEXITCODE -ne 0) { throw 'Build launcher compilation failed' }
    & ./tools/quiet_exec.exe gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -Wno-misleading-indentation -Werror -municode -mwindows -static-libgcc '-Wl,--disable-auto-import' @files -o dist/LanSync.exe -lole32 -luuid -lavrt -lws2_32 -lbcrypt -lcrypt32 -liphlpapi -lshell32 -luser32 -lgdi32 -lwinmm -lwintrust -ladvapi32 -lm
    if ($LASTEXITCODE -ne 0) { throw 'C compilation failed' }
    Copy-Item tools/Start-Test.cmd dist/Start-Test.cmd
    if ($Test) {
        & gcc -std=c11 -O2 -Wall -Wextra -Werror tests/test_sync.c src/sync.c -o dist/test_sync.exe -lm
        if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed' }
        & ./dist/test_sync.exe
        if ($LASTEXITCODE -ne 0) { throw 'Sync test failed' }
        & node --check web/client.js
        if ($LASTEXITCODE -ne 0) { throw 'Browser script syntax check failed' }
        & node tests/client_playback.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Browser original-speed playback check failed' }
    }
    Get-Item dist/LanSync.exe | Select-Object FullName,Length
} finally { Pop-Location }
