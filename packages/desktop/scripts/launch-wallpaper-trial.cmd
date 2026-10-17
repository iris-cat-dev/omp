@echo off
setlocal
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0launch-wallpaper-trial.ps1" -AppPath "%~dp0..\release\wallpaper-trial\win-unpacked\OMP Desktop.exe"
if errorlevel 1 (
  echo OMP Wallpaper Trial could not start. Keep the error message above.
  pause
  exit /b 1
)
exit /b 0
