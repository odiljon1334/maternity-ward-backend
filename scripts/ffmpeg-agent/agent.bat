@echo off
:: ═══════════════════════════════════════════════════════════════════
:: Maternity Ward — FFmpeg Agent (Windows)
:: ═══════════════════════════════════════════════════════════════════
:: Ishlatish:
::   1. ffmpeg.exe ni PATH ga qo'shing yoki shu papkaga joylang
::   2. Quyidagi sozlamalarni o'zgartiring
::   3. agent.bat ni ishga tushiring
::
:: Avtomatik ishga tushirish (Windows startup):
::   Win+R → shell:startup → agent.bat ni nusxalang
:: ═══════════════════════════════════════════════════════════════════

:: ─── SOZLAMALAR ─────────────────────────────────────────────────
:: Parollar shu faylda SAQLANMAYDI. Ular yonidagi agent.env.bat dan olinadi
:: (namuna: agent.env.bat.example — nusxa olib to'ldiring).
if not exist "%~dp0agent.env.bat" (
  echo agent.env.bat topilmadi. agent.env.bat.example dan nusxa oling va to'ldiring.
  pause
  exit /b 1
)
call "%~dp0agent.env.bat"
if "%VPS_RTSP_PORT%"=="" set VPS_RTSP_PORT=8554
if "%CAM_USER%"=="" set CAM_USER=admin
set PUBLISH_AUTH=
if not "%PUBLISH_USER%"=="" set PUBLISH_AUTH=%PUBLISH_USER%:%PUBLISH_PASS%@

set CAM1_RTSP=rtsp://%CAM_USER%:%CAM_PASS%@%CAM1_ADDR%
set CAM2_RTSP=rtsp://%CAM_USER%:%CAM_PASS%@%CAM2_ADDR%

:: ─── ISHGA TUSHIRISH ─────────────────────────────────────────────
echo Maternity Ward FFmpeg Agent
echo VPS: %VPS_HOST%:%VPS_RTSP_PORT%
echo.

:: Cam1
start "FFmpeg-%CAM1_NAME%" /min cmd /c ^
  "ffmpeg -rtsp_transport tcp -i %CAM1_RTSP% -c:v copy -c:a aac -f rtsp rtsp://%PUBLISH_AUTH%%VPS_HOST%:%VPS_RTSP_PORT%/%HOSPITAL_ID%/%CAM1_NAME% -loglevel warning"

:: Cam2
start "FFmpeg-%CAM2_NAME%" /min cmd /c ^
  "ffmpeg -rtsp_transport tcp -i %CAM2_RTSP% -c:v copy -c:a aac -f rtsp rtsp://%PUBLISH_AUTH%%VPS_HOST%:%VPS_RTSP_PORT%/%HOSPITAL_ID%/%CAM2_NAME% -loglevel warning"

echo Stream boshlandi!
echo HLS URL lar:
echo   https://%VPS_HOST%/live/%HOSPITAL_ID%/%CAM1_NAME%/index.m3u8
echo   https://%VPS_HOST%/live/%HOSPITAL_ID%/%CAM2_NAME%/index.m3u8
echo.
pause
