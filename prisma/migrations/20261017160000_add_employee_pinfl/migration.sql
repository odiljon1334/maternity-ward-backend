-- JSHSHIR (PINFL) — ixtiyoriy, UzASBO bilan bog'lash uchun.
-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "pinfl" TEXT;

-- Bir muassasada bitta JSHSHIR bitta xodimda (NULL qiymatlar cheklanmaydi)
-- CreateIndex
CREATE UNIQUE INDEX "Employee_hospitalId_pinfl_key" ON "Employee"("hospitalId", "pinfl");
