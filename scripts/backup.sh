#!/usr/bin/env bash
set -euo pipefail

# MaternityCare — kunlik PostgreSQL backup skripti (Faza 3).
# VPS'da cron orqali ishga tushiriladi: maternity_postgres konteyneridan
# pg_dump oladi, siqadi, S3'ga yuklaydi va BACKUP_RETENTION_DAYS'dan
# eski nusxalarni (lokal + S3) tozalaydi.

PROJECT_DIR="/home/maternit-backend/maternity-ward-backend"
ENV_FILE="$PROJECT_DIR/.env.prod"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
FILENAME="maternity_ward_db_${TIMESTAMP}.sql.gz"

if [ ! -f "$ENV_FILE" ]; then
  echo "[XATO] $ENV_FILE topilmadi"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${POSTGRES_USER:=maternity_user}"
: "${POSTGRES_DB:=maternity_ward_db}"
: "${AWS_S3_BACKUP_BUCKET:?AWS_S3_BACKUP_BUCKET .env.prod'da ko'rsatilmagan}"
: "${AWS_DEFAULT_REGION:=us-east-1}"
: "${BACKUP_RETENTION_DAYS:=30}"

mkdir -p "$BACKUP_DIR"

echo "[INFO] $(date) — backup boshlandi: $FILENAME"

docker exec maternity_postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$BACKUP_DIR/$FILENAME"

# Truncated/corrupt dump S3'ga chiqib ketmasin. `gzip -t` siqilgan oqimning
# checksumini tekshiradi; bo'sh fayl ham backup deb qabul qilinmaydi.
if [ ! -s "$BACKUP_DIR/$FILENAME" ]; then
  echo "[XATO] Backup fayli bo'sh: $BACKUP_DIR/$FILENAME"
  exit 1
fi
gzip -t "$BACKUP_DIR/$FILENAME"

SIZE=$(du -h "$BACKUP_DIR/$FILENAME" | cut -f1)
echo "[OK] Lokal backup tekshirildi: $BACKUP_DIR/$FILENAME ($SIZE)"

echo "[INFO] S3'ga yuklanmoqda: s3://$AWS_S3_BACKUP_BUCKET/$FILENAME"
aws s3 cp "$BACKUP_DIR/$FILENAME" "s3://$AWS_S3_BACKUP_BUCKET/$FILENAME" \
  --region "$AWS_DEFAULT_REGION"
echo "[OK] S3'ga muvaffaqiyatli yuklandi"

# Lokal diskda faqat oxirgi 3 kunlik nusxani saqlaymiz (tezkor restore uchun,
# disk to'lib qolmasligi uchun) — asosiy uzoq muddatli nusxalar S3'da turadi.
find "$BACKUP_DIR" -name "maternity_ward_db_*.sql.gz" -mtime +3 -delete

# S3'da BACKUP_RETENTION_DAYS'dan eski bo'lgan nusxalarni o'chiramiz.
CUTOFF_DATE=$(date -d "-${BACKUP_RETENTION_DAYS} days" +%Y-%m-%d)
echo "[INFO] $CUTOFF_DATE'dan oldingi S3 nusxalari tekshirilmoqda..."

OLD_KEYS=$(aws s3api list-objects-v2 \
  --bucket "$AWS_S3_BACKUP_BUCKET" \
  --region "$AWS_DEFAULT_REGION" \
  --query "Contents[?LastModified<='${CUTOFF_DATE}'].Key" \
  --output text || true)

if [ -n "$OLD_KEYS" ] && [ "$OLD_KEYS" != "None" ]; then
  for KEY in $OLD_KEYS; do
    echo "[INFO] Eski nusxa o'chirilmoqda: $KEY"
    aws s3 rm "s3://$AWS_S3_BACKUP_BUCKET/$KEY" --region "$AWS_DEFAULT_REGION"
  done
else
  echo "[INFO] O'chiriladigan eski nusxa yo'q"
fi

echo "[OK] $(date) — backup jarayoni to'liq tugadi"
