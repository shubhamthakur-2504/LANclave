@echo off
rem `lanclave help` lists the commands. Runs lanclave.ps1 whatever PowerShell's
rem script policy; installed by LANclave, the script sits in lib\.
set "script=%~dp0lib\lanclave.ps1"
if not exist "%script%" set "script=%~dp0lanclave.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%script%" %*
