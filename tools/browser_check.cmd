@echo off
rem tools/browser_check.cmd —— 用 headless Chrome/Edge 跑浏览器自检（index.html?selftest=1）
rem 双击本文件即可。结果写入 %TEMP%\wubi86_selftest.txt
setlocal enabledelayedexpansion
set "ROOT=%~dp0.."
set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do if not defined CHROME if exist %%P set "CHROME=%%~P"
if not defined CHROME (
  echo [X] 找不到 Chrome / Edge。请手动用浏览器打开 index.html?selftest=1
  pause
  exit /b 2
)
set "OUT=%TEMP%\wubi86_selftest.txt"
"!CHROME!" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=12000 --dump-dom "file:///!ROOT:\=/!/index.html?selftest=1" > "!OUT!" 2>nul
findstr /C:"<title>SELFTEST" "!OUT!" >nul
if errorlevel 1 (
  echo [X] 自检没有跑完。原始输出: !OUT!
  pause
  exit /b 1
)
for /f "tokens=2 delims=<>" %%T in ('findstr /C:"<title>SELFTEST" "!OUT!"') do set "RESULT=%%T"
echo.
if "!RESULT!"=="SELFTEST PASS" (echo [OK] !RESULT!) else (echo [X] !RESULT!  ^(下面列出失败项^))
findstr /B /C:"FAIL  " "!OUT!"
echo.
echo 完整结果: !OUT!
pause
if "!RESULT!"=="SELFTEST PASS" exit /b 0
exit /b 1
