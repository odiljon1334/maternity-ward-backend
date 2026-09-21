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

# Ishlayotgan application image'larini deploydan oldin eslab qolamiz. Yangi
# container health check'dan o'tmasa, shu immutable image ID'lar bilan avtomatik
# rollback qilinadi. Postgres/Redis/Nginx bu jarayonda tegilmaydi.
capture_running_image() {
    local service="$1"
    local container_id
    container_id=$(compose ps -q "$service" 2>/dev/null || true)
    if [ -n "$container_id" ]; then
        docker inspect --format '{{.Image}}|{{.Config.Image}}' "$container_id"
    fi
}

rollback_applications() {
    set +e
    warn "Application rollback boshlandi..."

    local rollback_services=()
    if [ "$BACKEND_UPDATED" = true ] && [ -n "$OLD_BACKEND_IMAGE_ID" ] && [ -n "$OLD_BACKEND_IMAGE_REF" ]; then
        docker image tag "$OLD_BACKEND_IMAGE_ID" "$OLD_BACKEND_IMAGE_REF"
        rollback_services+=(backend)
    fi
    if [ "$FRONTEND_UPDATED" = true ] && [ -n "$OLD_FRONTEND_IMAGE_ID" ] && [ -n "$OLD_FRONTEND_IMAGE_REF" ]; then
        docker image tag "$OLD_FRONTEND_IMAGE_ID" "$OLD_FRONTEND_IMAGE_REF"
        rollback_services+=(frontend)
    fi

    if [ ${#rollback_services[@]} -eq 0 ]; then
        warn "Rollback uchun oldingi application image topilmadi."
        set -e
        return 1
    fi

    compose up -d --no-deps --force-recreate "${rollback_services[@]}"

    local rollback_healthy=false
    local backend_ok=false
    local frontend_ok=false
    for i in $(seq 1 12); do
        if compose exec -T backend wget -qO- http://localhost:5001/api/v1/health 2>/dev/null | grep -q '"status":"ok"'; then
            backend_ok=true
        fi
        if [ "$FRONTEND_UPDATED" = false ] || compose exec -T frontend wget -qO- http://localhost:5000/login >/dev/null 2>&1; then
            frontend_ok=true
        fi
        if [ "$backend_ok" = true ] && [ "$frontend_ok" = true ]; then
            rollback_healthy=true
            break
        fi
        sleep 5
    done

    if [ "$rollback_healthy" = true ]; then
        success "Rollback yakunlandi: oldingi application yana healthy."
        set -e
        return 0
    fi

    warn "Rollback containeri ham health check'dan o'tmadi — zudlik bilan loglarni tekshiring."
    compose logs --tail=100 backend
    set -e
    return 1
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

# Bind-mount qilingan nginx.conf diskda darhol yangilanadi, ammo Nginx workerlar
# reload bo'lmaguncha eski konfiguratsiyada qoladi. Avval yangi faylni tekshirib,
# xato bo'lsa application containerlariga tegmasdan deployni to'xtatamiz.
log "2.1. Nginx konfiguratsiyasi tekshirilmoqda..."
if [ -z "$(compose ps -q nginx 2>/dev/null)" ]; then
    error "Nginx container ishlamayapti; deploy xavfsiz davom eta olmaydi."
fi
if ! compose exec -T nginx nginx -t; then
    error "Nginx konfiguratsiyasida xato bor. Eski workerlar ishlashda davom etadi."
fi
success "Nginx konfiguratsiyasi to'g'ri"

# Build mavjud taglarni yangilashidan oldin ayni paytda productionda ishlayotgan
# image ID va nomlarini saqlab qolamiz.
OLD_BACKEND_IMAGE=$(capture_running_image backend)
OLD_BACKEND_IMAGE_ID=${OLD_BACKEND_IMAGE%%|*}
OLD_BACKEND_IMAGE_REF=${OLD_BACKEND_IMAGE#*|}
OLD_FRONTEND_IMAGE=$(capture_running_image frontend)
OLD_FRONTEND_IMAGE_ID=${OLD_FRONTEND_IMAGE%%|*}
OLD_FRONTEND_IMAGE_REF=${OLD_FRONTEND_IMAGE#*|}
BACKEND_UPDATED=false
FRONTEND_UPDATED=false

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

# ── 6. Application containerlarini yangilash ──────────────────
# Backend rolling usulda: yangi replica healthy bo'lmaguncha eski backend
# ishlashda davom etadi. Frontend esa faqat image o'zgarganda recreate qilinadi.
# postgres/redis/nginx ishlashda qoladi; global `down` QILINMAYDI.
log "6. Backend rolling deploy va frontend yangilanishi boshlanmoqda..."
APP_SERVICES=()

# Faqat image'i haqiqatan o'zgargan servisni recreate qilamiz. Masalan faqat
# frontend o'zgarsa, ishlab turgan backend va terminal webhook oqimi uzilmaydi.
if [ -z "$OLD_BACKEND_IMAGE_ID" ] || [ "$(docker image inspect --format '{{.Id}}' "$OLD_BACKEND_IMAGE_REF")" != "$OLD_BACKEND_IMAGE_ID" ]; then
    bash "$BACKEND_DIR/scripts/rolling-backend-deploy.sh" \
        "$BACKEND_DIR" "$COMPOSE_FILE" "$BACKEND_DIR/.env.prod"
    success "Backend uzilishsiz yangilandi"
fi
if [ -z "$OLD_FRONTEND_IMAGE_ID" ] || [ "$(docker image inspect --format '{{.Id}}' "$OLD_FRONTEND_IMAGE_REF")" != "$OLD_FRONTEND_IMAGE_ID" ]; then
    APP_SERVICES+=(frontend)
    FRONTEND_UPDATED=true
fi

if [ ${#APP_SERVICES[@]} -gt 0 ]; then
    compose up -d --no-deps --force-recreate "${APP_SERVICES[@]}"
    success "Yangilangan frontend containeri ishga tushirildi"
else
    success "Frontend image o'zgarmagan — container recreate qilinmadi"
fi

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
    rollback_applications || true
    error "Yangi backend health check'dan o'tmadi. Avtomatik rollback bajarildi; yuqoridagi natijani tekshiring."
fi

log "8. Frontend health check kutilmoqda..."
FRONTEND_HEALTHY=false
for i in $(seq 1 10); do
    if compose exec -T frontend wget -qO- http://localhost:5000/login >/dev/null 2>&1; then
        success "Frontend ishlamoqda (login: OK)"
        FRONTEND_HEALTHY=true
        break
    fi
    log "Frontend kutilmoqda... ($i/10)"
    sleep 5
done
if [ "$FRONTEND_HEALTHY" = false ]; then
    compose logs --tail=50 frontend
    rollback_applications || true
    error "Yangi frontend health check'dan o'tmadi. Avtomatik rollback bajarildi; yuqoridagi natijani tekshiring."
fi

# ── 9. Nginx reload ──────────────────────────────────────────
# `nginx -s reload` graceful: mavjud ulanishlar uzilmaydi, yangi workerlar
# tekshirilgan konfiguratsiya bilan ishga tushadi.
log "9. Nginx konfiguratsiyasi uzilishsiz yangilanmoqda..."
compose exec -T nginx nginx -s reload
success "Nginx graceful reload qilindi"

# ── 10. Status ───────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
compose ps
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
success "Deploy muvaffaqiyatli yakunlandi! 🚀"

echo "🪐Log ko'rish: docker compose --project-directory $BACKEND_DIR -f $COMPOSE_FILE --env-file $BACKEND_DIR/.env.prod logs -f --tail=200 backend"
