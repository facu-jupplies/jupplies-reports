@echo off
title Jupplies Reports
cd /d "%~dp0"

echo.
echo   Jupplies Reports
echo   =================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   ERROR: Node.js no encontrado
  echo   Instalar desde https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   Instalando dependencias...
  call npm install
  echo.
)

REM Matar proceso anterior en puerto 3000 si existe
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
  echo   Cerrando proceso anterior en puerto 3000...
  taskkill /F /PID %%a >nul 2>nul
)
timeout /t 2 /nobreak >nul

echo   Arrancando servidor en puerto 3000...
start "Jupplies Server" /min cmd /c "node server.js & pause"

timeout /t 4 /nobreak >nul

REM Verificar que el servidor arrancó
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ERROR: El servidor no arranco.
  echo   Revisa si hay errores arriba.
  echo.
  pause
  exit /b 1
)

echo   Servidor OK en http://localhost:3000
echo.

set CFLARED=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe

if not exist "%CFLARED%" (
  echo   Cloudflare Tunnel no instalado.
  echo   Acceso solo local: http://localhost:3000
  echo.
  echo   Para instalar: winget install Cloudflare.cloudflared
  echo.
  start http://localhost:3000
  echo   Mantene esta ventana abierta.
  pause
  exit /b 0
)

echo   Arrancando Cloudflare Tunnel...
echo   (La URL publica aparece abajo)
echo.
"%CFLARED%" tunnel --url http://localhost:3000

echo.
echo   El tunnel se cerro. El servidor sigue en localhost:3000
pause
