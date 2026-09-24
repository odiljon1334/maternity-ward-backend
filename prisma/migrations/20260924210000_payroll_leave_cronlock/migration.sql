-- 4-paket: oylik mantig'i, ta'tilni qaytarish, cron qulfi, davomat indeksi.
-- Hammasi faqat QO'SHADI (mavjud ma'lumot o'zgarmaydi).

-- O'tgan oydan o'tgan ushlanma/avans va haqsiz ta'til
ALTER TABLE "PayrollRecord" ADD COLUMN IF NOT EXISTS "carriedDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "PayrollRecord" ADD COLUMN IF NOT EXISTS "carriedAdvance" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "PayrollRecord" ADD COLUMN IF NOT EXISTS "unpaidLeaveDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayrollRecord" ADD COLUMN IF NOT EXISTS "unpaidLeaveDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Ta'tildan oldingi grafik holati
ALTER TABLE "Schedule" ADD COLUMN IF NOT EXISTS "preLeaveStatus" "ScheduleStatus";

-- Kunlik davomat so'rovlari (dashboard, hisobot) uchun
CREATE INDEX IF NOT EXISTS "AttendanceRecord_workDate_idx" ON "AttendanceRecord"("workDate");

-- Cron qulfi
CREATE TABLE IF NOT EXISTS "CronLock" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CronLock_pkey" PRIMARY KEY ("name")
);
