@echo off
rem Runs lanclave-run.ps1 from any terminal, whatever PowerShell's script policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lanclave-run.ps1" %*
