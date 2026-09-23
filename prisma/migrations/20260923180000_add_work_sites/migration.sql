-- Ish joylari (WorkSite) — FAZA 6, 4b (2026-09-23). Additive: faqat yangi
-- jadvallar va nullable ustun; mavjud ma'lumotga tegilmaydi.

CREATE TABLE "WorkSite" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "gpsLat" DOUBLE PRECISION NOT NULL,
    "gpsLng" DOUBLE PRECISION NOT NULL,
    "gpsRadius" INTEGER NOT NULL DEFAULT 200,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkSite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmployeeWorkSite" (
    "employeeId" TEXT NOT NULL,
    "workSiteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeWorkSite_pkey" PRIMARY KEY ("employeeId","workSiteId")
);

ALTER TABLE "AttendanceRecord" ADD COLUMN "checkInWorkSiteId" TEXT;

CREATE INDEX "WorkSite_hospitalId_isActive_idx" ON "WorkSite"("hospitalId", "isActive");
CREATE INDEX "EmployeeWorkSite_workSiteId_idx" ON "EmployeeWorkSite"("workSiteId");

ALTER TABLE "WorkSite" ADD CONSTRAINT "WorkSite_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeWorkSite" ADD CONSTRAINT "EmployeeWorkSite_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeWorkSite" ADD CONSTRAINT "EmployeeWorkSite_workSiteId_fkey" FOREIGN KEY ("workSiteId") REFERENCES "WorkSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_checkInWorkSiteId_fkey" FOREIGN KEY ("checkInWorkSiteId") REFERENCES "WorkSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
