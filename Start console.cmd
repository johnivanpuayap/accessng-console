@echo off
title accessNG Console
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
echo.
echo Console stopped.
pause
