CREATE TYPE "SchedulePlanningMode" AS ENUM ('STANDARD', 'POST_COVERAGE');
CREATE TYPE "MonthlySchedulePlanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ARCHIVED');
CREATE TYPE "SchedulePlanEntryType" AS ENUM ('WORKING', 'DAY_OFF', 'SICK', 'VACATION', 'MATERNITY_LEAVE', 'TRAINING', 'OTHER_ABSENCE');
CREATE TYPE "ScheduleChangeType" AS ENUM ('SUBSTITUTION', 'SWAP', 'ABSENCE');
CREATE TYPE "ScheduleChangeStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'APPROVED', 'REJECTED', 'CANCELLED');

ALTER TYPE "ScheduleStatus" ADD VALUE 'MATERNITY_LEAVE';
ALTER TYPE "ScheduleStatus" ADD VALUE 'TRAINING';
ALTER TYPE "ScheduleStatus" ADD VALUE 'OTHER_ABSENCE';

-- Existing hospitals remain on the current scheduling path until a
-- SUPER_ADMIN explicitly opts one hospital into POST_COVERAGE.
ALTER TABLE "Hospital"
ADD COLUMN "schedulePlanningMode" "SchedulePlanningMode" NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "Schedule"
  ADD COLUMN "sourcePlanId" TEXT,
  ADD COLUMN "sourceEntryId" TEXT,
  ADD COLUMN "scheduleChangeRequestId" TEXT;

CREATE TABLE "SchedulePost" (
  "id" TEXT NOT NULL,
  "hospitalId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "dailyCoverageMinutes" INTEGER NOT NULL DEFAULT 1440,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchedulePost_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SchedulePost_dailyCoverageMinutes_check" CHECK ("dailyCoverageMinutes" BETWEEN 1 AND 1440)
);

CREATE TABLE "MonthlySchedulePlan" (
  "id" TEXT NOT NULL,
  "hospitalId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "MonthlySchedulePlanStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlySchedulePlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlySchedulePlan_month_check" CHECK ("month" BETWEEN 1 AND 12),
  CONSTRAINT "MonthlySchedulePlan_year_check" CHECK ("year" BETWEEN 2000 AND 2200),
  CONSTRAINT "MonthlySchedulePlan_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "MonthlyScheduleEntry" (
  "id" TEXT NOT NULL,
  "hospitalId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "shiftId" TEXT,
  "entryType" "SchedulePlanEntryType" NOT NULL DEFAULT 'WORKING',
  "workDate" TIMESTAMP(3) NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyScheduleEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlyScheduleEntry_interval_check" CHECK (
    "startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt"
  ),
  CONSTRAINT "MonthlyScheduleEntry_working_interval_check" CHECK (
    "entryType" <> 'WORKING' OR ("startsAt" IS NOT NULL AND "endsAt" IS NOT NULL)
  )
);

CREATE TABLE "ScheduleChangeRequest" (
  "id" TEXT NOT NULL,
  "hospitalId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "type" "ScheduleChangeType" NOT NULL,
  "status" "ScheduleChangeStatus" NOT NULL DEFAULT 'REQUESTED',
  "absenceEntryType" "SchedulePlanEntryType",
  "primaryEntryId" TEXT NOT NULL,
  "counterpartEntryId" TEXT,
  "replacementEmployeeId" TEXT,
  "reason" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "acceptedById" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduleChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SchedulePost_hospitalId_code_key" ON "SchedulePost"("hospitalId", "code");
CREATE INDEX "SchedulePost_hospitalId_departmentId_isActive_idx" ON "SchedulePost"("hospitalId", "departmentId", "isActive");

CREATE UNIQUE INDEX "MonthlySchedulePlan_postId_year_month_version_key" ON "MonthlySchedulePlan"("postId", "year", "month", "version");
CREATE INDEX "MonthlySchedulePlan_hospitalId_year_month_status_idx" ON "MonthlySchedulePlan"("hospitalId", "year", "month", "status");

CREATE UNIQUE INDEX "MonthlyScheduleEntry_planId_employeeId_workDate_key" ON "MonthlyScheduleEntry"("planId", "employeeId", "workDate");
CREATE INDEX "MonthlyScheduleEntry_hospitalId_workDate_idx" ON "MonthlyScheduleEntry"("hospitalId", "workDate");

-- Workflow races must not create two active drafts or two approved
-- baselines for the same post/month.
CREATE UNIQUE INDEX "MonthlySchedulePlan_one_open_per_month_key"
  ON "MonthlySchedulePlan"("postId", "year", "month")
  WHERE "status" IN ('DRAFT', 'SUBMITTED');
CREATE UNIQUE INDEX "MonthlySchedulePlan_one_approved_per_month_key"
  ON "MonthlySchedulePlan"("postId", "year", "month")
  WHERE "status" = 'APPROVED';

CREATE INDEX "ScheduleChangeRequest_hospitalId_status_createdAt_idx" ON "ScheduleChangeRequest"("hospitalId", "status", "createdAt");
CREATE INDEX "ScheduleChangeRequest_planId_status_idx" ON "ScheduleChangeRequest"("planId", "status");
CREATE INDEX "ScheduleChangeRequest_replacementEmployeeId_status_idx" ON "ScheduleChangeRequest"("replacementEmployeeId", "status");
CREATE INDEX "Schedule_sourcePlanId_idx" ON "Schedule"("sourcePlanId");
CREATE INDEX "Schedule_scheduleChangeRequestId_idx" ON "Schedule"("scheduleChangeRequestId");

ALTER TABLE "SchedulePost" ADD CONSTRAINT "SchedulePost_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchedulePost" ADD CONSTRAINT "SchedulePost_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MonthlySchedulePlan" ADD CONSTRAINT "MonthlySchedulePlan_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlySchedulePlan" ADD CONSTRAINT "MonthlySchedulePlan_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SchedulePost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthlySchedulePlan" ADD CONSTRAINT "MonthlySchedulePlan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthlySchedulePlan" ADD CONSTRAINT "MonthlySchedulePlan_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MonthlyScheduleEntry" ADD CONSTRAINT "MonthlyScheduleEntry_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyScheduleEntry" ADD CONSTRAINT "MonthlyScheduleEntry_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MonthlySchedulePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyScheduleEntry" ADD CONSTRAINT "MonthlyScheduleEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthlyScheduleEntry" ADD CONSTRAINT "MonthlyScheduleEntry_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "ShiftTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MonthlySchedulePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_primaryEntryId_fkey" FOREIGN KEY ("primaryEntryId") REFERENCES "MonthlyScheduleEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_counterpartEntryId_fkey" FOREIGN KEY ("counterpartEntryId") REFERENCES "MonthlyScheduleEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_replacementEmployeeId_fkey" FOREIGN KEY ("replacementEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
