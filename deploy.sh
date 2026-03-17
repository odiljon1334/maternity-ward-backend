#!/bin/bash
set -e

echo "🚀 Maternity Ward — Backend deploy boshlandi..."

# 1) Yangi kodni tortib olish
echo "📦 git pull..."
git pull origin main

# 2) .env.prod borligini tekshirish
if [ ! -f .env.prod ]; then
  echo "❌ .env.prod fayli topilmadi!"
  echo "   Yarating: cp .env.prod.example .env.prod && nano .env.prod"
  exit 1
fi

# 3) Docker build va ishga tushirish
echo "🐳 Docker build va start..."
docker compose --env-file .env.prod -f docker-compose.server.yml up -d --build

# 4) Eski imagelarni tozalash
echo "🧹 Eski docker imagelarni tozalash..."
docker image prune -f

echo ""
echo "✅ Backend deploy tugadi!"
echo "📋 Log ko'rish:  docker logs maternity_backend --tail=50 -f"
echo "🗄️  DB log:       docker logs maternity_postgres --tail=20"
