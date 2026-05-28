@echo off
REM Double-click this to update Progress Tracker to the latest version.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from nodejs.org first.
  pause
  exit /b 1
)

node update.mjs
