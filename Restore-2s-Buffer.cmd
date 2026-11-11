@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Set-LiveBuffer.ps1" -Mode stable
pause
