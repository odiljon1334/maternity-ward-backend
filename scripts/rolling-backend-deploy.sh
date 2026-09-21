#!/usr/bin/env bash
set -euo pipefail

# Bitta backenddan ikkinchisiga uzilishsiz o'tish moduli.
# Interface: bash scripts/rolling-backend-deploy.sh BACKEND_DIR COMPOSE_FILE ENV_FILE
# Invariant: boshlanishida aynan bitta backend container ishlashi kerak.

BACKEND_DIR=${1:?BACKEND_DIR kiritilmagan}
COMPOSE_FILE=${2:?COMPOSE_FILE kiritilmagan}
ENV_FILE=${3:?ENV_FILE kiritilmagan}
DOCKER_BIN=${DOCKER_BIN:-docker}
HEALTH_ATTEMPTS=${ROLLING_HEALTH_ATTEMPTS:-30}
HEALTH_INTERVAL_SECONDS=${ROLLING_HEALTH_INTERVAL_SECONDS:-5}
SWITCH_SETTLE_SECONDS=${ROLLING_SWITCH_SETTLE_SECONDS:-2}
FINAL_HEALTH_ATTEMPTS=${ROLLING_FINAL_HEALTH_ATTEMPTS:-10}

compose() {
  "$DOCKER_BIN" compose \
    --project-directory "$BACKEND_DIR" \
    -f "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    "$@"
}

log() { echo "[ROLLING] $*"; }
fail() { echo "[ROLLING ERROR] $*" >&2; exit 1; }

old_containers=()
while IFS= read -r container; do
  [ -n "$container" ] && old_containers+=("$container")
done < <(compose ps -q backend)
if [ ${#old_containers[@]} -ne 1 ]; then
  fail "Rolling deploy boshlanishida 1 ta backend kutilgan, topildi: ${#old_containers[@]}"
fi

old_container=${old_containers[0]}
old_image_id=$("$DOCKER_BIN" inspect --format '{{.Image}}' "$old_container")
image_ref=$("$DOCKER_BIN" inspect --format '{{.Config.Image}}' "$old_container")
new_image_id=$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$image_ref")

if [ "$old_image_id" = "$new_image_id" ]; then
  log "Backend image o'zgarmagan — rolling almashtirish kerak emas."
  exit 0
fi

cleanup_candidate() {
  local candidate=${1:-}
  [ -z "$candidate" ] && return 0
  "$DOCKER_BIN" stop --time 10 "$candidate" >/dev/null 2>&1 || true
  "$DOCKER_BIN" rm "$candidate" >/dev/null 2>&1 || true
}

restore_old_backend() {
  local candidate=${1:-}
  log "Yangi backend o'tmadi — eski backend tiklanmoqda..."
  "$DOCKER_BIN" start "$old_container" >/dev/null 2>&1 || true
  # Avval eski backendni upstreamga qaytaramiz; shundan keyingina nomzodni
  # to'xtatamiz. Shu tartib rollbackning o'zida ham bo'sh upstream qoldirmaydi.
  compose exec -T nginx nginx -s reload >/dev/null 2>&1 || true
  cleanup_candidate "$candidate"
  "$DOCKER_BIN" image tag "$old_image_id" "$image_ref" >/dev/null 2>&1 || true
  compose exec -T nginx nginx -s reload >/dev/null 2>&1 || true
}

log "Yangi backend replica eski containerni to'xtatmasdan yaratilmoqda..."
compose up -d --no-deps --scale backend=2 --no-recreate backend

scaled_containers=()
while IFS= read -r container; do
  [ -n "$container" ] && scaled_containers+=("$container")
done < <(compose ps -q backend)
candidate=''
for container in "${scaled_containers[@]}"; do
  if [ "$container" != "$old_container" ]; then
    candidate=$container
    break
  fi
done

if [ -z "$candidate" ]; then
  fail "Yangi backend replica yaratilmadi; eski backend ishlashda davom etmoqda."
fi

candidate_ready=false
for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if "$DOCKER_BIN" exec "$candidate" wget -qO- http://localhost:5001/api/v1/health 2>/dev/null | grep -q '"status":"ok"'; then
    candidate_ready=true
    break
  fi
  log "Yangi backend kutilmoqda... ($i/$HEALTH_ATTEMPTS)"
  sleep "$HEALTH_INTERVAL_SECONDS"
done

if [ "$candidate_ready" != true ]; then
  "$DOCKER_BIN" logs --tail=100 "$candidate" || true
  cleanup_candidate "$candidate"
  fail "Yangi backend healthy bo'lmadi; eski backendga tegilmadi."
fi

log "Yangi backend healthy. Nginx ikkala replica bilan yangilanmoqda..."
compose exec -T nginx nginx -t
compose exec -T nginx nginx -s reload
sleep "$SWITCH_SETTLE_SECONDS"

# Nest SIGTERM'da app.close() qiladi; Docker 30 soniyagacha mavjud so'rovlar
# tugashini kutadi. Shu paytda Nginx yangi replica orqali so'rov qabul qiladi.
log "Eski backend graceful to'xtatilmoqda..."
if ! "$DOCKER_BIN" stop --time 30 "$old_container" >/dev/null; then
  restore_old_backend "$candidate"
  fail "Eski backendni graceful to'xtatib bo'lmadi."
fi

# To'xtagan container Docker DNS'dan chiqadi; reload upstreamda faqat yangi
# backendni qoldiradi.
if ! compose exec -T nginx nginx -t || ! compose exec -T nginx nginx -s reload; then
  restore_old_backend "$candidate"
  fail "Nginx yangi backendga o'tolmadi; eski backend tiklandi."
fi

final_ready=false
for i in $(seq 1 "$FINAL_HEALTH_ATTEMPTS"); do
  if compose exec -T nginx wget -qO- http://127.0.0.1/api/v1/health 2>/dev/null | grep -q '"status":"ok"'; then
    final_ready=true
    break
  fi
  sleep "$HEALTH_INTERVAL_SECONDS"
done

if [ "$final_ready" != true ]; then
  restore_old_backend "$candidate"
  fail "Nginx orqali yakuniy health check o'tmadi; eski backend tiklandi."
fi

"$DOCKER_BIN" rm "$old_container" >/dev/null
log "Rolling deploy tugadi: yangi backend xizmatda, eski container olib tashlandi."
