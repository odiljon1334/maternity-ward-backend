#!/bin/bash
# ============================================================
# deploy-frontend.sh — Faqat Frontend ni yangilash
#
# Postgres, Redis, Backend, Nginx — TO'XTATILMAYDI
# Frontend downtime: ~10 soniya (build tugagach container swap)
#
# Ishlatish: bash deploy-frontend.sh
# ============================================================

set -e

BACKEND_DIR="/home/maternit-backend/maternity-ward-backend"
FRONTEND_DIR="/home/maternit-backend/maternity-ward-frontend"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo "🎨 =============================================="
echo "   Frontend Deploy (Backend/DB saqlanadi)"
echo "================================================"
echo ""

# ── 1. Yangi kod ─────────────────────────────────────────────
log "1. Frontend kodi yangilanmoqda..."
cd "$FRONTEND_DIR"
git fetch origin main
git reset --hard origin/main
ok "Kod yangilandi"

# ── 2. Build — eski frontend hali ishlayapti! ─────────────────
log "2. Yangi image build qilinmoqda (eski frontend hali ishlayapti)..."
log "   (Next.js build 2-3 daqiqa — foydalanuvchilar ko'rmaydi)"
cd "$BACKEND_DIR"
docker compose -f docker-compose.production.yml --env-file .env.prod \
    build --no-cache frontend
ok "Build tugadi — hozir container almashtiriladi"

# ── 3. Faqat frontend restart (~10s downtime) ─────────────────
log "3. Frontend container almashtirilmoqda..."
docker compose -f docker-compose.production.yml --env-file .env.prod \
    up -d --no-deps frontend
ok "Frontend yangi container bilan ishga tushdi"

# ── 4. Eski imagelar ──────────────────────────────────────────
docker image prune -f >/dev/null 2>&1

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker compose -f docker-compose.production.yml --env-file .env.prod ps frontend
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
ok "Frontend deploy yakunlandi! 🚀"
ok "Log ko'rish: docker compose -f docker-compose.production.yml logs frontend -f"
