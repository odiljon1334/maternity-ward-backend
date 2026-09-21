CREATE TABLE "OperationalServiceMonitor" (
    "serviceKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HEALTHY',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "outageStartedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalServiceMonitor_pkey" PRIMARY KEY ("serviceKey")
);
