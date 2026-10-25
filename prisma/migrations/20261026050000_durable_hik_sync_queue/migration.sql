CREATE TABLE "HikSyncTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hospitalId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'WAITING',
  "snapshot" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  CONSTRAINT "HikSyncTask_state_check" CHECK ("state" IN ('WAITING', 'ACTIVE', 'DONE', 'FAILED'))
);
CREATE INDEX "HikSyncTask_hospitalId_createdAt_idx" ON "HikSyncTask"("hospitalId", "createdAt");
CREATE INDEX "HikSyncTask_state_availableAt_idx" ON "HikSyncTask"("state", "availableAt");
-- Multiple API replicas may enqueue concurrently; only one unfinished task per tenant.
CREATE UNIQUE INDEX "HikSyncTask_one_active_hospital" ON "HikSyncTask"("hospitalId") WHERE "state" IN ('WAITING', 'ACTIVE');
