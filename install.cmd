@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
    echo.
    echo Installation failed. Review the message above.
    pause
    exit /b 1
)
echo.
echo Installation complete. Restart Codex and VS Code to load the MCP server.
pause
endlocal
