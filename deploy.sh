#!/bin/bash
# ============================================================
# deploy.sh — Maternity Ward Production Deploy
# VPS da ishlatish: bash deploy.sh
# ============================================================

set -e  # Har qanday xatoda to'xtasin

BACKEND_DIR="/home/deploy/maternity-ward-backend"
FRONTEND_DIR="/home/deploy/maternity-ward-frontend"
COMPOSE_FILE="$BACKEND_DIR/docker-compose.production.yml"

# Ranglar
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "🏥 =============================================="
echo "   Maternity Ward — Production Deploy"
echo "================================================"
echo ""

# ── 1. .env.prod tekshirish ──────────────────────────────────
log "1. .env.prod tekshirilmoqda..."
if [ ! -f "$BACKEND_DIR/.env.prod" ]; then
    error ".env.prod topilmadi! $BACKEND_DIR/.env.prod yarating."
fi

# Muhim env varlarni tekshirish
required_vars=("POSTGRES_PASSWORD" "JWT_SECRET" "FRONTEND_URL" "NEXT_PUBLIC_API_URL")
for var in "${required_vars[@]}"; do
    value=$(grep "^$var=" "$BACKEND_DIR/.env.prod" | cut -d '=' -f2-)
    if [ -z "$value" ] || [[ "$value" == *"REPLACE"* ]] || [[ "$value" == *"YOUR_"* ]]; then
        error "$var .env.prod da bo'sh yoki to'ldirilmagan!"
    fi
done
success ".env.prod tekshirildi"

# ── 2. Repo update ───────────────────────────────────────────
log "2. Kod yangilanmoqda..."
cd "$BACKEND_DIR" && git pull origin main
cd "$FRONTEND_DIR" && git pull origin main
success "Kod yangilandi"

# ── 3. Eski containerlarni to'xtatish ───────────────────────
log "3. Eski containerlar to'xtatilmoqda..."
cd "$BACKEND_DIR"
docker compose -f docker-compose.production.yml down --remove-orphans 2>/dev/null || true
success "Containerlar to'xtatildi"

# ── 4. Build ─────────────────────────────────────────────────
log "4. Docker image build qilinmoqda (bu biroz vaqt oladi)..."
docker compose -f docker-compose.production.yml --env-file .env.prod build --no-cache
success "Build tugadi"

# ── 5. Start ─────────────────────────────────────────────────
log "5. Servislar ishga tushirilmoqda..."
docker compose -f docker-compose.production.yml --env-file .env.prod up -d
success "Servislar ishga tushdi"

# ── 6. Health check ──────────────────────────────────────────
log "6. Health check (60s kutilmoqda)..."
sleep 60

MAX_TRIES=10
for i in $(seq 1 $MAX_TRIES); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/api/v1/health 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
        success "Backend ishlamoqda (health: OK)"
        break
    fi
    if [ $i -eq $MAX_TRIES ]; then
        warn "Health check muvaffaqiyatsiz — loglarni tekshiring:"
        docker logs maternity_backend --tail=50
    fi
    log "Kutilmoqda... ($i/$MAX_TRIES)"
    sleep 10
done

# ── 7. Eski image larni tozalash ─────────────────────────────
log "7. Eski Docker imagelar tozalanmoqda..."
docker image prune -f
success "Eski imagelar o'chirildi"

# ── 8. Status ────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker compose -f docker-compose.production.yml ps
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
success "Deploy muvaffaqiyatli yakunlandi! 🚀"
