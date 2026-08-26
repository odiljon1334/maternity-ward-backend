#!/bin/bash
# ============================================================
# deploy.sh — Maternity Ward Production Deploy
# VPS da ishlatish: bash deploy.sh
# ============================================================

set -e  # Har qanday xatoda to'xtasin

# BuildKit'ni yoqish — cache mount (npm ci uchun) va umuman
# tezroq, parallel build shu orqali ishlaydi
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

BACKEND_DIR="/home/maternit-backend/maternity-ward-backend"
FRONTEND_DIR="/home/maternit-backend/maternity-ward-frontend"
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
cd "$BACKEND_DIR"
git fetch origin main
git reset --hard origin/main
cd "$FRONTEND_DIR"
git fetch origin main
git reset --hard origin/main
success "Kod yangilandi"

# ── 3. Barcha maternity containerlarni to'xtatish ───────────
log "3. Barcha eski containerlar o'chirilmoqda..."
# Compose orqali to'xtatish
cd "$BACKEND_DIR"
docker compose -f docker-compose.production.yml down --remove-orphans 2>/dev/null || true
# Qolgan maternity containerlarni ham o'chirish (boshqa compose fayllar bilan ishgantushganlar)
docker ps -a --format "{{.Names}}" | grep -i "maternity" | xargs -r docker rm -f 2>/dev/null || true
success "Containerlar o'chirildi"

# ── 4. Build ─────────────────────────────────────────────────
# DIQQAT: --no-cache olib tashlandi. Kod git reset --hard bilan
# allaqachon yangilangan (2-qadam), shuning uchun Docker layer
# cache "eski kod" muammosini keltirib chiqarmaydi — u fayllar
# haqiqatan o'zgarganini avtomatik aniqlaydi va faqat kerakli
# qatlamlarni qayta quradi. --no-cache har safar HAMMA narsani
# (shu jumladan npm ci'ni ham) noldan bajarishga majburlar edi.
log "4. Docker image build qilinmoqda..."
docker compose -f docker-compose.production.yml --env-file .env.prod build
success "Build tugadi"

# ── 5. Start ─────────────────────────────────────────────────
log "5. Servislar ishga tushirilmoqda..."
docker compose -f docker-compose.production.yml --env-file .env.prod up -d
success "Servislar ishga tushdi"

# ── 6. Database migratsiyasi ─────────────────────────────────
log "6. Database migratsiyasi ishga tushirilmoqda..."
sleep 15  # Backend container va DB to'liq ishga tushsin

MIGRATE_OK=false
for i in 1 2 3; do
    if docker exec maternity-ward-backend-backend-1 npx prisma migrate deploy 2>&1; then
        success "Migratsiya bajarildi"
        MIGRATE_OK=true
        break
    fi
    warn "Migratsiya urinishi $i muvaffaqiyatsiz, 10s kutilmoqda..."
    sleep 10
done
if [ "$MIGRATE_OK" = false ]; then
    error "Migratsiya 3 marta urinishdan keyin ham bajarilmadi!"
fi

# ── 7. Health check ──────────────────────────────────────────
log "7. Health check (45s kutilmoqda)..."
sleep 45

MAX_TRIES=10
for i in $(seq 1 $MAX_TRIES); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/api/v1/health 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
        success "Backend ishlamoqda (health: OK)"
        break
    fi
    if [ $i -eq $MAX_TRIES ]; then
        warn "Health check muvaffaqiyatsiz — loglarni tekshiring:"
        docker logs maternity-ward-backend-backend-1 --tail=50
    fi
    log "Kutilmoqda... ($i/$MAX_TRIES)"
    sleep 10
done

# ── 8. Eski image larni tozalash ─────────────────────────────
log "8. Eski Docker imagelar tozalanmoqda..."
docker image prune -f
success "Eski imagelar o'chirildi"

# ── 9. Status ────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker compose -f docker-compose.production.yml ps
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
success "Deploy muvaffaqiyatli yakunlandi! 🚀"

echo "🪐Log ko'rish: docker logs maternity-ward-backend-backend-1 -f --tail=200"
