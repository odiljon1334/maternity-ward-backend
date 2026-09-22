CREATE TYPE "PayrollAdjustmentType" AS ENUM (
  'OVERTIME_PAY',
  'CONTRACTUAL_KPI_BONUS',
  'ONE_TIME_AWARD',
  'DISCIPLINARY_FINE',
  'OTHER_LAWFUL_DEDUCTION'
);

CREATE TYPE "PayrollAdjustmentStatus" AS ENUM (
  'PENDING_EXPLANATION',
  'PENDING_APPROVAL',
  'PENDING_ACKNOWLEDGEMENT',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'APPLIED'
);

CREATE TYPE "SalaryAdvanceStatus" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'PAID',
  'REJECTED',
  'CANCELLED',
  'APPLIED'
);

ALTER TABLE "PayrollRecord"
  ADD COLUMN "contractualKpiBonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "oneTimeAward" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "disciplinaryFine" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "otherLawfulDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "deferredDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "advancePaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "advanceApplied" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "deferredAdvance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "grossSalary" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE "PayrollAdjustment" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "hospitalId" TEXT NOT NULL,
  "payrollRecordId" TEXT,
  "month" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "type" "PayrollAdjustmentType" NOT NULL,
  "status" "PayrollAdjustmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "proposedAmount" DECIMAL(12,2) NOT NULL,
  "approvedAmount" DECIMAL(12,2),
  "reason" TEXT NOT NULL,
  "policyReference" TEXT,
  "evidence" JSONB,
  "explanationRequestedAt" TIMESTAMP(3),
  "employeeExplanation" TEXT,
  "explanationSubmittedAt" TIMESTAMP(3),
  "explanationRefusedAt" TIMESTAMP(3),
  "orderNumber" TEXT,
  "orderDate" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "calculationBaseAmount" DECIMAL(12,2),
  "finePercent" DECIMAL(5,2),
  "createdById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalaryAdvance" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "hospitalId" TEXT NOT NULL,
  "payrollRecordId" TEXT,
  "month" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "status" "SalaryAdvanceStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedAmount" DECIMAL(12,2) NOT NULL,
  "approvedAmount" DECIMAL(12,2),
  "paidAmount" DECIMAL(12,2),
  "note" TEXT,
  "paymentReference" TEXT,
  "requestedById" TEXT NOT NULL,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalaryAdvance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayrollAdjustment_hospitalId_year_month_idx" ON "PayrollAdjustment"("hospitalId", "year", "month");
CREATE INDEX "PayrollAdjustment_employeeId_year_month_idx" ON "PayrollAdjustment"("employeeId", "year", "month");
CREATE INDEX "PayrollAdjustment_status_idx" ON "PayrollAdjustment"("status");
CREATE INDEX "SalaryAdvance_hospitalId_year_month_idx" ON "SalaryAdvance"("hospitalId", "year", "month");
CREATE INDEX "SalaryAdvance_employeeId_year_month_idx" ON "SalaryAdvance"("employeeId", "year", "month");
CREATE INDEX "SalaryAdvance_status_idx" ON "SalaryAdvance"("status");

ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
