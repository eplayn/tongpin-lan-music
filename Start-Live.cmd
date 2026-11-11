@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Music.ps1"
if errorlevel 1 goto end
start "" "http://127.0.0.1:8877/live/"
:end
pause
