-- HR bot ulanish ruxsati (allowlist) — 2026-09-23 xavfsizlik auditi.
-- Additive: yangi ustunlar, mavjud ma'lumot o'chirilmaydi.

ALTER TABLE "Employee" ADD COLUMN "telegramBotAccess" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TelegramSubscription" ADD COLUMN "employeeId" TEXT;

CREATE INDEX "TelegramSubscription_employeeId_idx" ON "TelegramSubscription"("employeeId");

ALTER TABLE "TelegramSubscription" ADD CONSTRAINT "TelegramSubscription_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: hozir botga ulana oladiganlar (DIRECTOR/ADMIN loginli faol
-- xodimlar) ruxsatni avtomatik oladi — deploy'dan keyin hech kim bloklanmaydi.
UPDATE "Employee" e
SET "telegramBotAccess" = true
FROM "User" u
WHERE e."userId" = u."id"
  AND u."role" IN ('DIRECTOR', 'ADMIN')
  AND e."firedAt" IS NULL;
