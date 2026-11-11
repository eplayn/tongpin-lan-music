@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Configure-Firewall.ps1"
if errorlevel 1 goto end
:end
pause
