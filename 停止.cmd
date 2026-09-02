@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM --------------------------------------------------------------------
REM  Stop the server. Same two rules as the start launcher: CRLF only,
REM  ASCII only -- comments included. Chinese lives in scripts\msg\.
REM
REM  Find the process BY PORT, not by name: killing every node.exe would
REM  take the user's editor and other dev servers with it.
REM --------------------------------------------------------------------

type scripts\msg\stop-banner.txt

REM A dual-stack listener shows up as two LISTENING rows (v4 and v6) for the
REM same PID -- skip PIDs already handled so the window doesn't claim it
REM killed two things.
set FOUND=0
for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":30035 " ^| findstr LISTENING') do (
  if not defined SEEN_%%I (
    set SEEN_%%I=1
    echo   port 30035  ^-^-^>  killing PID %%I
    taskkill /F /T /PID %%I >nul 2>nul
    set FOUND=1
  )
)

echo.
if "%FOUND%"=="0" (
  type scripts\msg\stop-none.txt
) else (
  type scripts\msg\stop-done.txt
)
pause >nul
