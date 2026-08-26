# syntax=docker/dockerfile:1.7
# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Dependencies (devDeps ham kerak — TypeScript build va Prisma CLI uchun)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

COPY . .
RUN DATABASE_URL=postgresql://dummy:dummy@localhost/dummy npx prisma generate
RUN npm run build

# devDependencies'ni endi kerak emas — tarmoqsiz, tez tozalash
# (alohida "npm ci --omit=dev" bosqichidan ancha tezroq)
RUN npm prune --omit=dev --legacy-peer-deps

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# uploads papkasi va foydalanuvchini OLDIN yaratamiz — shunda COPY --chown
# to'g'ridan-to'g'ri to'g'ri egalik bilan ko'chiradi, alohida "chown -R"
# (avvalgi loglarda 271s / 473s yeb qo'ygan qadam) kerak bo'lmaydi
RUN mkdir -p uploads && addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --chown=appuser:appgroup --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/package*.json ./
COPY --chown=appuser:appgroup --from=builder /app/dist ./dist
COPY --chown=appuser:appgroup --from=builder /app/prisma ./prisma

# uploads papkasini appuser'ga tegishli qilish (bo'sh papka — tez)
RUN chown appuser:appgroup uploads

USER appuser

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:5001/api/v1/health || exit 1

# Migrate qilib keyin serverni start qilish
# NODE_OPTIONS docker-compose da ham override qilish mumkin
CMD ["sh", "-c", "npx prisma migrate deploy && node --max-old-space-size=${NODE_MEMORY_MB:-4096} dist/src/main"]
