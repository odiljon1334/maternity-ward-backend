-- CreateEnum
CREATE TYPE "OpenShiftStatus" AS ENUM ('OPEN', 'CLAIMED', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OpenShiftOfferResponse" AS ENUM ('ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "OpenShift" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shiftId" TEXT NOT NULL,
    "absentEmployeeId" TEXT,
    "status" "OpenShiftStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdById" TEXT,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenShiftOffer" (
    "id" TEXT NOT NULL,
    "openShiftId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "response" "OpenShiftOfferResponse",
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenShiftOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenShift_hospitalId_status_idx" ON "OpenShift"("hospitalId", "status");

-- CreateIndex
CREATE INDEX "OpenShift_hospitalId_date_idx" ON "OpenShift"("hospitalId", "date");

-- CreateIndex
CREATE INDEX "OpenShiftOffer_employeeId_idx" ON "OpenShiftOffer"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "OpenShiftOffer_openShiftId_employeeId_key" ON "OpenShiftOffer"("openShiftId", "employeeId");

-- AddForeignKey
ALTER TABLE "OpenShift" ADD CONSTRAINT "OpenShift_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenShift" ADD CONSTRAINT "OpenShift_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenShift" ADD CONSTRAINT "OpenShift_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "ShiftTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenShift" ADD CONSTRAINT "OpenShift_absentEmployeeId_fkey" FOREIGN KEY ("absentEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenShift" ADD CONSTRAINT "OpenShift_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenShiftOffer" ADD CONSTRAINT "OpenShiftOffer_openShiftId_fkey" FOREIGN KEY ("openShiftId") REFERENCES "OpenShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenShiftOffer" ADD CONSTRAINT "OpenShiftOffer_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
