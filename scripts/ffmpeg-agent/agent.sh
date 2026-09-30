#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Maternity Ward — FFmpeg RTSP → VPS MediaMTX Agent
# ═══════════════════════════════════════════════════════════════════
# Har bir poliklinikada shu script ishlaydi (Linux/Mac).
# Windows uchun: agent.bat faylini ishlating.
#
# O'rnatish:
#   chmod +x agent.sh
#   ./agent.sh
#
# Avtomatik ishga tushirish (Linux systemd):
#   sudo cp maternity-agent.service /etc/systemd/system/
#   sudo systemctl enable maternity-agent
#   sudo systemctl start maternity-agent
# ═══════════════════════════════════════════════════════════════════

# ─── SOZLAMALAR ─────────────────────────────────────────────────────
# Bu qiymatlarni o'zgartiring:

# Parollar shu faylda SAQLANMAYDI (repo'ga tushib qolmasin). Ular yonidagi
# agent.env faylidan o'qiladi — namunasi: agent.env.example.
AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$AGENT_DIR/agent.env" ]; then
  # shellcheck disable=SC1091
  . "$AGENT_DIR/agent.env"
else
  echo "agent.env topilmadi. Nusxa oling: cp agent.env.example agent.env va to'ldiring."
  exit 1
fi

VPS_HOST="${VPS_HOST:?VPS_HOST agent.env da kerak}"
VPS_RTSP_PORT="${VPS_RTSP_PORT:-8554}"
HOSPITAL_ID="${HOSPITAL_ID:?HOSPITAL_ID agent.env da kerak}"
CAM_USER="${CAM_USER:-admin}"
CAM_PASS="${CAM_PASS:?CAM_PASS agent.env da kerak}"
# VPS'ga oqim yuborish logini (MediaMTX publish). Bo'sh bo'lsa — loginsiz.
PUBLISH_USER="${PUBLISH_USER:-}"
PUBLISH_PASS="${PUBLISH_PASS:-}"

# Kameralar ro'yxati: "kamera_nomi|ip:port/yo'l" (login/parol CAM_USER/CAM_PASS dan)
CAMERAS=(${CAMERAS_LIST:-"cam1|192.168.1.64:554/Streaming/Channels/101"})

# ─── FFMPEG PATH ────────────────────────────────────────────────────
FFMPEG_BIN=$(which ffmpeg)
if [ -z "$FFMPEG_BIN" ]; then
  echo "FFmpeg topilmadi! O'rnatish: sudo apt install ffmpeg"
  exit 1
fi

echo "═══════════════════════════════════════════════════"
echo " Maternity Ward FFmpeg Agent"
echo " VPS: $VPS_HOST:$VPS_RTSP_PORT"
echo " Hospital: $HOSPITAL_ID"
echo " Kameralar: ${#CAMERAS[@]} ta"
echo "═══════════════════════════════════════════════════"

# ─── HAR BIR KAMERA UCHUN FFMPEG BACKGROUND PROCESS ───────────────
PIDS=()

start_camera() {
  local CAM_NAME="$1"
  local RTSP_SRC="$2"
  local STREAM_PATH="${HOSPITAL_ID}/${CAM_NAME}"
  local AUTH=""
  [ -n "$PUBLISH_USER" ] && AUTH="${PUBLISH_USER}:${PUBLISH_PASS}@"
  local VPS_RTSP="rtsp://${AUTH}${VPS_HOST}:${VPS_RTSP_PORT}/${STREAM_PATH}"

  echo "▶ $CAM_NAME → rtsp://${VPS_HOST}:${VPS_RTSP_PORT}/${STREAM_PATH}"

  while true; do
    $FFMPEG_BIN \
      -rtsp_transport tcp \
      -i "$RTSP_SRC" \
      -c:v copy \
      -c:a aac \
      -f rtsp \
      -rtsp_transport tcp \
      "$VPS_RTSP" \
      -loglevel warning \
      2>>/tmp/ffmpeg_${CAM_NAME}.log

    EXIT_CODE=$?
    echo "[$(date '+%H:%M:%S')] $CAM_NAME uzildi (exit=$EXIT_CODE), 5 soniyadan keyin qayta ulanadi..."
    sleep 5
  done
}

# Barcha kameralarni parallel ishga tushirish
for CAMERA in "${CAMERAS[@]}"; do
  CAM_NAME="${CAMERA%%|*}"
  RTSP_URL="rtsp://${CAM_USER}:${CAM_PASS}@${CAMERA##*|}"
  start_camera "$CAM_NAME" "$RTSP_URL" &
  PIDS+=($!)
done

echo ""
echo "✓ ${#PIDS[@]} ta kamera stream boshlandi"
echo "  HLS URL (browser uchun):"
for CAMERA in "${CAMERAS[@]}"; do
  CAM_NAME="${CAMERA%%|*}"
  echo "  https://${VPS_HOST}/live/${HOSPITAL_ID}/${CAM_NAME}/index.m3u8"
done
echo ""
echo "To'xtatish uchun: Ctrl+C"

# Ctrl+C bosilganda barcha processlarni to'xtatish
trap 'echo "Toxtayapti..."; kill "${PIDS[@]}"; exit 0' SIGINT SIGTERM

# Barcha backgroundlarni kutish
wait "${PIDS[@]}"
