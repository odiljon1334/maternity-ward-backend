-- "Kechikaman" xabarlari va uzrli kechikish
CREATE TYPE "AttendanceNoticeType" AS ENUM ('LATE_ARRIVAL');
CREATE TYPE "AttendanceNoticeReason" AS ENUM ('TRAFFIC', 'TRANSPORT', 'FAMILY', 'HEALTH', 'OTHER');
CREATE TYPE "AttendanceNoticeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

ALTER TABLE "AttendanceRecord" ADD COLUMN "excusedLateMin" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AttendanceNotice" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "type" "AttendanceNoticeType" NOT NULL DEFAULT 'LATE_ARRIVAL',
    "reason" "AttendanceNoticeReason" NOT NULL,
    "comment" TEXT,
    "workDate" TIMESTAMP(3) NOT NULL,
    "delayMinutes" INTEGER NOT NULL,
    "status" "AttendanceNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttendanceNotice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AttendanceNotice_hospitalId_status_workDate_idx" ON "AttendanceNotice"("hospitalId", "status", "workDate");
CREATE INDEX "AttendanceNotice_employeeId_workDate_idx" ON "AttendanceNotice"("employeeId", "workDate");
ALTER TABLE "AttendanceNotice" ADD CONSTRAINT "AttendanceNotice_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceNotice" ADD CONSTRAINT "AttendanceNotice_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
