#!/bin/bash
# ═══════════════════════════════════════════════════════
# Maternity Ward — Local dev + ngrok
# Barcha servislarni bir vaqtda ishga tushiradi
# ═══════════════════════════════════════════════════════
# Ishlatish: ./scripts/dev-start.sh

set -e

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$BACKEND_DIR/../maternity-ward-frontend"

echo "════════════════════════════════════════"
echo " Maternity Ward — Dev Start"
echo "════════════════════════════════════════"

# ─── 0. Eski processlarni tozalash
echo "▶ Eski processlar o'ldirilmoqda..."
lsof -ti:5001 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
pkill -f "nest start" 2>/dev/null || true
pkill -f "next dev"   2>/dev/null || true
pkill -f ngrok        2>/dev/null || true
sleep 1

# ─── 1. MediaMTX (binary)
echo "▶ MediaMTX ishga tushmoqda..."
MEDIAMTX_BIN="/tmp/mediamtx"
if [ ! -f "$MEDIAMTX_BIN" ]; then
  echo "  MediaMTX yuklanmoqda..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    MTX_ARCH="darwin_arm64"
  else
    MTX_ARCH="darwin_amd64"
  fi
  curl -sL "https://github.com/bluenviron/mediamtx/releases/download/v1.9.1/mediamtx_v1.9.1_${MTX_ARCH}.tar.gz" -o /tmp/mediamtx.tar.gz
  tar -xzf /tmp/mediamtx.tar.gz -C /tmp mediamtx
  chmod +x "$MEDIAMTX_BIN"
fi
lsof -ti:8554 | xargs kill -9 2>/dev/null || true
lsof -ti:8888 | xargs kill -9 2>/dev/null || true
MTX_HLSALWAYSREMUX=yes MTX_HLSSEGMENTCOUNT=3 MTX_HLSSEGMENTDURATION=2s \
  "$MEDIAMTX_BIN" &>/tmp/mediamtx.log &
MEDIAMTX_PID=$!
echo "  MediaMTX PID=$MEDIAMTX_PID"

# ─── 2. Backend
echo "▶ Backend ishga tushmoqda (port 5001)..."
cd "$BACKEND_DIR"
source ~/.nvm/nvm.sh 2>/dev/null
nvm use 18 2>/dev/null || true
npm run start:dev &
BACKEND_PID=$!

# ─── 3. Frontend
echo "▶ Frontend ishga tushmoqda (port 3000)..."
cd "$FRONTEND_DIR"
npm run dev &
FRONTEND_PID=$!

# ─── 4. ngrok (barcha tunnellar)
echo ""
echo "▶ ngrok tunnellar ochilmoqda..."
sleep 4
ngrok start --all --config "$BACKEND_DIR/scripts/ngrok.yml" &
NGROK_PID=$!

sleep 3

# ─── 5. ngrok URL larini ko'rsatish
echo ""
echo "════════════════════════════════════════"
echo " ngrok URL lar:"
curl -s http://localhost:4040/api/tunnels 2>/dev/null | \
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for t in data.get('tunnels', []):
        print(f'  {t[\"name\"]:<12} → {t[\"public_url\"]}')
except:
    print('  ngrok admin: http://localhost:4040')
"
BACKEND_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | \
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for t in data.get('tunnels', []):
        if t.get('name') == 'backend':
            print(t['public_url'])
            break
except: pass
" 2>/dev/null)

echo ""
echo " .env.local ga qo'shing (maternity-ward-frontend/.env.local):"
if [ -n "$BACKEND_URL" ]; then
  echo "   NEXT_PUBLIC_API_URL=${BACKEND_URL}/api/v1"
else
  echo "   NEXT_PUBLIC_API_URL=https://<backend-ngrok-url>/api/v1"
fi
echo "   MEDIAMTX_HLS_HOST=http://localhost:8888  (local test uchun)"
echo "════════════════════════════════════════"
echo ""
echo "To'xtatish: Ctrl+C"

# Ctrl+C — hammani to'xtatish
cleanup() {
  echo ""
  echo "To'xtatilmoqda..."
  kill $BACKEND_PID $FRONTEND_PID $NGROK_PID $MEDIAMTX_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

wait
