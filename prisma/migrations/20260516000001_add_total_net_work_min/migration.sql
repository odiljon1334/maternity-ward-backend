-- AlterTable: PayrollRecord ga totalNetWorkMin ustuni qo'shish
-- IF NOT EXISTS — ikki marta ishga tushsa ham xato bermaydi
ALTER TABLE "PayrollRecord" ADD COLUMN IF NOT EXISTS "totalNetWorkMin" INTEGER NOT NULL DEFAULT 0;
