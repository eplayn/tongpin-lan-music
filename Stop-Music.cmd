@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Music.ps1"
if errorlevel 1 goto end
:end
pause
