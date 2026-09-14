@echo off
rem Double-click to start PlumiMemoLang on Windows. The first time, it installs what the
rem app needs; then it starts the app and opens it in your browser. Close this window
rem (or press Ctrl+C) to stop the app. Your data stays in the data folder next to it.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)"
if errorlevel 1 goto oldnode

if exist node_modules goto start
echo First start: installing what the app needs...
call npm install --omit=dev
if errorlevel 1 goto failed

:start
echo Starting PlumiMemoLang. Close this window, or press Ctrl+C, to stop it.
call npm run launch
pause
exit /b 0

:nonode
echo PlumiMemoLang needs Node.js 22.12 or newer, and Node.js is not installed.
goto getnode

:oldnode
echo PlumiMemoLang needs Node.js 22.12 or newer. This computer has:
node -v

:getnode
echo Install the LTS version from https://nodejs.org, then double-click this file again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:failed
pause
exit /b 1
