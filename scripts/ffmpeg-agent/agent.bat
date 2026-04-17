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
set VPS_HOST=vps-ip-yoki-domen
set VPS_RTSP_PORT=8554
set HOSPITAL_ID=hospital1

:: Kameralar (har bir qator uchun alohida ffmpeg oynasi ochiladi)
set CAM1_NAME=cam1
set CAM1_RTSP=rtsp://admin:Admin123@192.168.1.64:554/Streaming/Channels/101

set CAM2_NAME=cam2
set CAM2_RTSP=rtsp://admin:Admin123@192.168.1.65:554/Streaming/Channels/101

:: ─── ISHGA TUSHIRISH ─────────────────────────────────────────────
echo Maternity Ward FFmpeg Agent
echo VPS: %VPS_HOST%:%VPS_RTSP_PORT%
echo.

:: Cam1
start "FFmpeg-%CAM1_NAME%" /min cmd /c ^
  "ffmpeg -rtsp_transport tcp -i %CAM1_RTSP% -c:v copy -c:a aac -f rtsp rtsp://%VPS_HOST%:%VPS_RTSP_PORT%/%HOSPITAL_ID%/%CAM1_NAME% -loglevel warning"

:: Cam2
start "FFmpeg-%CAM2_NAME%" /min cmd /c ^
  "ffmpeg -rtsp_transport tcp -i %CAM2_RTSP% -c:v copy -c:a aac -f rtsp rtsp://%VPS_HOST%:%VPS_RTSP_PORT%/%HOSPITAL_ID%/%CAM2_NAME% -loglevel warning"

echo Stream boshlandi!
echo HLS URL lar:
echo   https://%VPS_HOST%/live/%HOSPITAL_ID%/%CAM1_NAME%/index.m3u8
echo   https://%VPS_HOST%/live/%HOSPITAL_ID%/%CAM2_NAME%/index.m3u8
echo.
pause
