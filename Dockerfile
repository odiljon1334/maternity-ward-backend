# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Dependencies (devDeps ham kerak — TypeScript build uchun)
COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Faqat production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Build artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# node_modules dan prisma client ko'chirish
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Uploads papkasi (volumes bilan mount qilinadi)
RUN mkdir -p uploads && addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 5001

# Migrate qilib keyin serverni start qilish
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
