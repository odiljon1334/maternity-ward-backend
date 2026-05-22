-- LeaveType enum
CREATE TYPE "LeaveType" AS ENUM ('VACATION', 'SICK', 'PERSONAL', 'MATERNITY', 'UNPAID');

-- LeaveStatus enum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- LeaveRequest jadval
CREATE TABLE "LeaveRequest" (
  "id"          TEXT NOT NULL,
  "employeeId"  TEXT NOT NULL,
  "hospitalId"  TEXT NOT NULL,
  "type"        "LeaveType"   NOT NULL DEFAULT 'VACATION',
  "startDate"   TIMESTAMP(3) NOT NULL,
  "endDate"     TIMESTAMP(3) NOT NULL,
  "daysCount"   INTEGER      NOT NULL DEFAULT 1,
  "reason"      TEXT,
  "status"      "LeaveStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedBy"  TEXT,
  "reviewNote"  TEXT,
  "reviewedAt"  TIMESTAMP(3),
  "documentUrl" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "LeaveRequest_employeeId_idx"         ON "LeaveRequest"("employeeId");
CREATE INDEX "LeaveRequest_hospitalId_status_idx"  ON "LeaveRequest"("hospitalId", "status");
CREATE INDEX "LeaveRequest_emp_dates_idx"          ON "LeaveRequest"("employeeId", "startDate", "endDate");

-- Foreign keys
ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
