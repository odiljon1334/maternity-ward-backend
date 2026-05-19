#!/bin/bash
# ============================================================
# deploy-backend.sh — Faqat Backend ni yangilash
#
# Postgres, Redis, Frontend, Nginx — TO'XTATILMAYDI
# Backend downtime: ~20-30 soniya (restart vaqti)
#
# Ishlatish: bash deploy-backend.sh
# ============================================================

set -e

BACKEND_DIR="/home/maternit-backend/maternity-ward-backend"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "⚙️  =============================================="
echo "   Backend Deploy (DB/Frontend saqlanadi)"
echo "================================================"
echo ""

cd "$BACKEND_DIR"

# ── 1. Yangi kod ─────────────────────────────────────────────
log "1. Backend kodi yangilanmoqda..."
git fetch origin main
git reset --hard origin/main
ok "Kod yangilandi"

# ── 2. Build (eski container hali ishlayapti) ─────────────────
log "2. Yangi image build qilinmoqda (DB/Frontend ishlayapti)..."
docker compose -f docker-compose.production.yml --env-file .env.prod \
    build --no-cache backend
ok "Build tugadi"

# ── 3. Faqat backend restart ──────────────────────────────────
log "3. Backend container almashtirilmoqda (~20s downtime)..."
docker compose -f docker-compose.production.yml --env-file .env.prod \
    up -d --no-deps backend
ok "Backend yangi container bilan ishga tushdi"

# ── 4. Migration ──────────────────────────────────────────────
log "4. Database migration tekshirilmoqda..."
sleep 12

MIGRATE_OK=false
for i in 1 2 3; do
    if docker compose -f docker-compose.production.yml exec -T backend \
        npx prisma migrate deploy 2>&1; then
        ok "Migration bajarildi (yoki yangilik yo'q)"
        MIGRATE_OK=true
        break
    fi
    warn "Migration urinishi $i/3 — 8s kutilmoqda..."
    sleep 8
done
[ "$MIGRATE_OK" = false ] && err "Migration 3 marta urinishdan keyin ham bajarilmadi!"

# ── 5. Health check ───────────────────────────────────────────
log "5. Health check..."
for i in $(seq 1 8); do
    HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/api/v1/health 2>/dev/null)
    if [ "$HTTP" = "200" ]; then
        ok "Backend ishlamoqda ✓"
        break
    fi
    if [ "$i" -eq 8 ]; then
        warn "Health check javob bermadi — loglar:"
        docker compose -f docker-compose.production.yml logs backend --tail=30
    fi
    log "Kutilmoqda... ($i/8)"; sleep 8
done

# ── 6. Eski imagelar ──────────────────────────────────────────
docker image prune -f >/dev/null 2>&1

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker compose -f docker-compose.production.yml ps backend
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
ok "Backend deploy yakunlandi! 🚀"
