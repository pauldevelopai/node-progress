@echo off
REM Double-click this to launch Progress Tracker.
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 3 >nul && start http://localhost:3000"
npm start
