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
# Compose fayli va yagona production .env.prod backend repo ichida.
# Frontend yangilangach shu yerga qaytmasak Docker Compose frontend papkasidan
# .env.prod qidiradi va build boshlanishidan oldin to'xtaydi.
cd "$BACKEND_DIR"
success "Kod yangilandi"

# ── 3. Build (ishlayotgan servislar TO'XTATILMAYDI) ───────────
# DIQQAT: --no-cache olib tashlandi. Kod git reset --hard bilan
# allaqachon yangilangan (2-qadam), shuning uchun Docker layer
# cache "eski kod" muammosini keltirib chiqarmaydi — u fayllar
# haqiqatan o'zgarganini avtomatik aniqlaydi va faqat kerakli
# qatlamlarni qayta quradi. --no-cache har safar HAMMA narsani
# (shu jumladan npm ci'ni ham) noldan bajarishga majburlar edi.
log "3. Docker image build qilinmoqda (production ishlashda davom etadi)..."
docker compose -f docker-compose.production.yml --env-file .env.prod build
success "Build tugadi"

# ── 4. Database migratsiyasi (yangi image bilan, app almashtirishdan oldin) ──
# Dockerfile startup ichida migrate qilmaydi: bu parallel replica race'ini
# va noto'g'ri image sabab deploydagi outage'ni oldini oladi.
log "4. Database migratsiyasi tekshirilmoqda..."
docker compose -f docker-compose.production.yml --env-file .env.prod \
  run --rm --no-deps backend npx prisma migrate deploy
success "Migratsiya bajarildi"

# ── 5. Faqat application containerlarini yangilash ────────────
# postgres/redis/nginx/face-match ishlashda qoladi; global `down` QILINMAYDI.
log "5. Backend va frontend yangilanmoqda..."
docker compose -f docker-compose.production.yml --env-file .env.prod \
  up -d --no-deps --force-recreate backend frontend
success "Application containerlari yangilandi"

# ── 6. Health check ──────────────────────────────────────────
log "6. Backend health check kutilmoqda..."

MAX_TRIES=10
HEALTHY=false
for i in $(seq 1 $MAX_TRIES); do
    if docker compose -f docker-compose.production.yml --env-file .env.prod \
        exec -T backend wget -qO- http://localhost:5001/api/v1/health 2>/dev/null | grep -q '"status":"ok"'; then
        success "Backend ishlamoqda (health: OK)"
        HEALTHY=true
        break
    fi
    if [ $i -eq $MAX_TRIES ]; then
        warn "Health check muvaffaqiyatsiz — loglarni tekshiring:"
        docker compose -f docker-compose.production.yml --env-file .env.prod logs --tail=50 backend
    fi
    log "Kutilmoqda... ($i/$MAX_TRIES)"
    sleep 10
done
if [ "$HEALTHY" = false ]; then
    error "Yangi backend health check'dan o'tmadi. Nginx va ma'lumotlar bazasi to'xtatilmadi; backend logini tekshirib rollback qiling."
fi

# ── 7. Status ────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker compose -f docker-compose.production.yml ps
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
success "Deploy muvaffaqiyatli yakunlandi! 🚀"

echo "🪐Log ko'rish: docker compose -f docker-compose.production.yml --env-file .env.prod logs -f --tail=200 backend"
