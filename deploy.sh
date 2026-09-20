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
# Deploy qaysi papkadan chaqirilishidan qat'i nazar, Compose doim backend
# repo va uning yagona production .env.prod faylidan foydalanadi.
compose() {
    docker compose \
        --project-directory "$BACKEND_DIR" \
        -f "$COMPOSE_FILE" \
        --env-file "$BACKEND_DIR/.env.prod" \
        "$@"
}

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
compose build
success "Build tugadi"

# ── 4. Database migratsiyasi (yangi image bilan, app almashtirishdan oldin) ──
# Dockerfile startup ichida migrate qilmaydi: bu parallel replica race'ini
# va noto'g'ri image sabab deploydagi outage'ni oldini oladi.
log "4. Database migratsiyasi tekshirilmoqda..."
compose run --rm --no-deps backend npx prisma migrate deploy
success "Migratsiya bajarildi"

# ── 5. Face-match readiness ───────────────────────────────────
# Yangi InsightFace image'ni backenddan OLDIN tayyorlaymiz. Terminal webhook
# eski healthy backendga kelishda davom etadi; yangi backend faqat model ready
# bo'lgandan keyin almashtiriladi.
log "5. Face-match modeli tayyorlanmoqda..."
compose up -d --no-deps --force-recreate face-match

FACE_MATCH_READY=false
for i in $(seq 1 18); do
    if compose exec -T face-match python -c "import json, urllib.request; assert json.load(urllib.request.urlopen('http://localhost:8000/health'))['status'] == 'ready'" 2>/dev/null; then
        success "Face-match modeli tayyor (health: ready)"
        FACE_MATCH_READY=true
        break
    fi
    log "Face-match modeli yuklanmoqda... ($i/18)"
    sleep 5
done
if [ "$FACE_MATCH_READY" = false ]; then
    warn "Face-match ready bo'lmadi — loglarni tekshiring:"
    compose logs --tail=100 face-match
    error "Face-match modeli tayyor bo'lmagani uchun backend almashtirilmadi. Eski backend va terminal webhooklar ishlashda davom etadi."
fi

# ── 6. Faqat application containerlarini yangilash ────────────
# postgres/redis/nginx ishlashda qoladi; global `down` QILINMAYDI.
log "6. Backend va frontend yangilanmoqda..."
compose up -d --no-deps --force-recreate backend frontend
success "Application containerlari yangilandi"

# ── 7. Health check ──────────────────────────────────────────
log "7. Backend health check kutilmoqda..."

MAX_TRIES=10
HEALTHY=false
for i in $(seq 1 $MAX_TRIES); do
    if compose exec -T backend wget -qO- http://localhost:5001/api/v1/health 2>/dev/null | grep -q '"status":"ok"'; then
        success "Backend ishlamoqda (health: OK)"
        HEALTHY=true
        break
    fi
    if [ $i -eq $MAX_TRIES ]; then
        warn "Health check muvaffaqiyatsiz — loglarni tekshiring:"
        compose logs --tail=50 backend
    fi
    log "Kutilmoqda... ($i/$MAX_TRIES)"
    sleep 10
done
if [ "$HEALTHY" = false ]; then
    error "Yangi backend health check'dan o'tmadi. Nginx va ma'lumotlar bazasi to'xtatilmadi; backend logini tekshirib rollback qiling."
fi

# ── 8. Status ────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
compose ps
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
success "Deploy muvaffaqiyatli yakunlandi! 🚀"

echo "🪐Log ko'rish: docker compose --project-directory $BACKEND_DIR -f $COMPOSE_FILE --env-file $BACKEND_DIR/.env.prod logs -f --tail=200 backend"
