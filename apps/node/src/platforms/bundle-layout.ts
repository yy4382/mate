import type { BundleLayout, PlatformId } from "./types.ts";

const POSIX_LAUNCHER = `#!/bin/sh
command=$0
while [ -L "$command" ]; do
  directory=$(CDPATH= cd -- "$(dirname -- "$command")" && pwd)
  target=$(readlink "$command")
  case "$target" in
    /*) command=$target ;;
    *) command=$directory/$target ;;
  esac
done
program=$(CDPATH= cd -- "$(dirname -- "$command")/.." && pwd)
exec "$program/node/bin/node" "$program/lib/mate.mjs" "$@"
`;

const WINDOWS_LAUNCHER = `@echo off
rem Mate node bundle launcher.
setlocal DisableDelayedExpansion
if /I "%~nx0"=="mate-manage.cmd" goto manage
if /I "%~1"=="node" if /I "%~2"=="update" goto prepare
if /I "%~1"=="node" if /I "%~2"=="uninstall" goto prepare
"%~dp0..\\node\\node.exe" "%~dp0..\\lib\\mate.mjs" %*
exit /b %errorlevel%

:prepare
if not defined TEMP (
  echo TEMP is missing; cannot prepare the management runtime. 1>&2
  exit /b 1
)
set "mate_temporary=%TEMP%\\mate-node-cli-%RANDOM%-%RANDOM%"
mkdir "%mate_temporary%" 2>nul
if errorlevel 1 (
  echo Could not create the temporary management directory. 1>&2
  exit /b 1
)
copy /Y "%~dp0..\\node\\node.exe" "%mate_temporary%\\node.exe" >nul
if errorlevel 1 (
  echo Could not copy the management runtime from "%~dp0..\\node\\node.exe" to "%mate_temporary%\\node.exe". 1>&2
  goto failed
)
copy /Y "%~dp0..\\lib\\mate.mjs" "%mate_temporary%\\mate.mjs" >nul
if errorlevel 1 (
  echo Could not copy the management program from "%~dp0..\\lib\\mate.mjs" to "%mate_temporary%\\mate.mjs". 1>&2
  goto failed
)
copy /Y "%~f0" "%mate_temporary%\\mate-manage.cmd" >nul
if errorlevel 1 (
  echo Could not copy the management launcher from "%~f0" to "%mate_temporary%\\mate-manage.cmd". 1>&2
  goto failed
)
"%mate_temporary%\\mate-manage.cmd" %*

:failed
del /Q "%mate_temporary%\\node.exe" "%mate_temporary%\\mate.mjs" "%mate_temporary%\\mate-manage.cmd" 2>nul
rmdir "%mate_temporary%" 2>nul
exit /b 1

:manage
"%~dp0node.exe" "%~dp0mate.mjs" %*
exit /b %errorlevel%
`.replaceAll("\n", "\r\n");

const POSIX_BUNDLE = {
  runtime: "node/bin/node",
  command: "bin/mate",
  launcher: POSIX_LAUNCHER,
};

export const bundleLayouts: Record<PlatformId, BundleLayout> = {
  linux: { ...POSIX_BUNDLE, name: "linux" },
  darwin: { ...POSIX_BUNDLE, name: "darwin" },
  win32: {
    name: "win",
    runtime: "node/node.exe",
    command: "bin/mate.cmd",
    launcher: WINDOWS_LAUNCHER,
  },
};
