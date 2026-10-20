@echo off
rem Runs lanclave-run.ps1 from any terminal, whatever PowerShell's script policy.
rem Installed by LANclave, the script sits in lib\ so PowerShell finds this
rem file, not the script, when you type lanclave-run.
set "script=%~dp0lib\lanclave-run.ps1"
if not exist "%script%" set "script=%~dp0lanclave-run.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%script%" %*
