@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM --------------------------------------------------------------------
REM  Windows launcher -- double-click it.
REM
REM  TWO RULES, both measured the hard way (see 365/031). Keep them.
REM
REM  1) This file MUST be CRLF. (.gitattributes pins *.cmd eol=crlf.)
REM     With LF, cmd.exe eats the first character or two of every line:
REM     `chcp 65001` becomes "'5001' is not recognized". The server still
REM     comes up, but the window fills with errors and a non-technical
REM     user reads that as "broken".
REM
REM  2) This file MUST stay ASCII-only -- comments included. cmd.exe reads
REM     a batch file in fixed-size blocks; a multi-byte UTF-8 character
REM     straddling a block boundary gets split and the rest of that line
REM     is executed as a command. It depends on byte offsets, so adding
REM     one comment line can move the breakage or bring it back.
REM
REM  The Chinese lives in scripts\msg\*.txt (UTF-8), printed with `type`.
REM  `type` never goes through the batch parser -- it streams bytes to a
REM  console that `chcp 65001` already set to UTF-8.
REM --------------------------------------------------------------------

type scripts\msg\banner.txt

where node >nul 2>nul
if errorlevel 1 (
  type scripts\msg\no-node.txt
  pause
  exit /b 1
)

REM Build artifact can go stale: "npm run build" isn't part of double-click
REM launch, so a git pull that changes server/src without a rebuild leaves
REM server\dist\index.js on disk (this check alone would say "already built")
REM while its content is the old code. Compare mtimes with PowerShell (this
REM repo already depends on it for scripts\toast.ps1) instead of just
REM existence. NEED_BUILD starts at 1 (rebuild) and only flips to 0 when
REM PowerShell explicitly confirms the build is newer than every file under
REM server\src -- any other outcome (stale, or PowerShell itself failing)
REM leaves it at 1, so ambiguity defaults to the safe, slower path.
REM
REM The exist-check and the ERRORLEVEL read below are NOT wrapped in one
REM "if exist (...)" block on purpose: %ERRORLEVEL% inside a parenthesized
REM block is substituted once, when the block is PARSED, not after each line
REM actually runs -- reading it right after the powershell call in the same
REM block would silently see the value from before the block started. goto
REM keeps both as top-level statements so the read happens after the call.
set "NEED_BUILD=1"
set "BUILD_MSG=scripts\msg\first-run.txt"
if not exist "server\dist\index.js" goto :after_build_check
set "BUILD_MSG=scripts\msg\rebuild.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$src = (Get-ChildItem -Path 'server\src' -Recurse -File | Measure-Object -Property LastWriteTime -Maximum).Maximum; $dist = (Get-Item 'server\dist\index.js').LastWriteTime; exit ([int]($src -gt $dist))"
if "%ERRORLEVEL%"=="0" set "NEED_BUILD=0"
:after_build_check

if "%NEED_BUILD%"=="1" (
  type "%BUILD_MSG%"
  call npm run go
) else (
  type scripts\msg\starting.txt
  call npm start
)

REM errorlevel 0 here means npm's own process exited cleanly on its own --
REM today that only happens when index.js finds another instance already
REM running, prints its own line, and exits 0 without ever binding. That
REM line already said what happened; don't print anything on top of it that
REM presupposes a stop or an error. Any other exit code means the server ran
REM and then died -- taskkill, Ctrl+C, closing this window, or a real crash
REM -- and npm can't tell those apart, so ended.txt says so honestly instead
REM of guessing.
REM
REM NOT "if errorlevel 1": that means "errorlevel >= 1", a SIGNED compare,
REM and abnormal termination hands out negative codes -- Ctrl+C is
REM STATUS_CONTROL_C_EXIT = 0xC000013A = -1073741510, an access violation
REM is 0xC0000005 = -1073741819. Both are less than 1, so "errorlevel 1"
REM takes the wrong branch and a real crash prints nothing but "press any
REM key". Test for "not exactly zero" instead.
if not "%ERRORLEVEL%"=="0" (
  type scripts\msg\ended.txt
)
type scripts\msg\press-key.txt
pause >nul
