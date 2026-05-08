-- AlterTable: AttendanceRecord ga netWorkMin ustuni qoshish
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "netWorkMin" INTEGER NOT NULL DEFAULT 0;
