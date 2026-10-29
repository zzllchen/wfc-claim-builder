@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Host this folder on a web server instead, see README.md.
  pause
  exit /b 1
)
start "" http://localhost:8080/
python -m http.server 8080
