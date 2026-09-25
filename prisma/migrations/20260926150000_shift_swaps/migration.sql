-- Oddiy grafikdagi smena almashish
CREATE TYPE "ShiftSwapType" AS ENUM ('SWAP', 'COVER');
CREATE TYPE "ShiftSwapStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'DECLINED', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "ShiftSwapRequest" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "type" "ShiftSwapType" NOT NULL,
    "requesterId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "requesterDate" TIMESTAMP(3) NOT NULL,
    "requesterShiftId" TEXT,
    "targetDate" TIMESTAMP(3),
    "targetShiftId" TEXT,
    "reason" TEXT,
    "status" "ShiftSwapStatus" NOT NULL DEFAULT 'REQUESTED',
    "respondedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShiftSwapRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShiftSwapRequest_hospitalId_status_idx" ON "ShiftSwapRequest"("hospitalId", "status");
CREATE INDEX "ShiftSwapRequest_requesterId_idx" ON "ShiftSwapRequest"("requesterId");
CREATE INDEX "ShiftSwapRequest_targetId_idx" ON "ShiftSwapRequest"("targetId");
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_hospitalId_fkey"
    FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
