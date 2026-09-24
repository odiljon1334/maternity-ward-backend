-- FAZA 6 · 2-paket: obuna qoplamasi (months), Telegram invoyslari va takroriy to'lovdan himoya

-- 1. Qoplanadigan oylar soni (yillik to'lov 12 oyni qoplaydi)
ALTER TABLE "Payment" ADD COLUMN "months" INTEGER NOT NULL DEFAULT 1;
UPDATE "Payment" SET "months" = 12 WHERE "type" = 'ANNUAL';

ALTER TABLE "Payment" ADD COLUMN "providerPaymentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "invoiceId" TEXT;

-- 2. Bitta Telegram to'lovi (charge id) ikki marta yozilgan bo'lsa — birinchisi
--    saqlanadi, qolganlarining charge id si belgilanadi (summa/holat o'zgartirilmaydi,
--    administrator ko'rib chiqishi uchun izoh qo'shiladi), so'ng UNIQUE qo'yiladi.
WITH dups AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "telegramPaymentId" ORDER BY "createdAt", "id") AS rn
  FROM "Payment"
  WHERE "telegramPaymentId" IS NOT NULL
)
UPDATE "Payment" p
SET "telegramPaymentId" = p."telegramPaymentId" || '#dup-' || p."id",
    "note" = COALESCE(p."note" || ' ', '') || '[TAKRORIY Telegram to''lov yozuvi — tekshiring]'
FROM dups
WHERE p."id" = dups."id" AND dups.rn > 1;

CREATE UNIQUE INDEX "Payment_telegramPaymentId_key" ON "Payment"("telegramPaymentId");
CREATE UNIQUE INDEX "Payment_invoiceId_key" ON "Payment"("invoiceId");
CREATE INDEX "Payment_hospitalId_status_period_idx" ON "Payment"("hospitalId", "status", "period");

-- 3. Telegram obuna invoyslari
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('OPEN', 'PAID', 'EXPIRED');

CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "type" "PaymentType" NOT NULL,
    "months" INTEGER NOT NULL,
    "startPeriod" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "employeeCount" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionInvoice_hospitalId_status_idx" ON "SubscriptionInvoice"("hospitalId", "status");
CREATE INDEX "SubscriptionInvoice_status_expiresAt_idx" ON "SubscriptionInvoice"("status", "expiresAt");

ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubscriptionInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
