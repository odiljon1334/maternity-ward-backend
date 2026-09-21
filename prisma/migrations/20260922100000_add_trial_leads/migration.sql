CREATE TYPE "TrialLeadSource" AS ENUM ('WEB_FORM', 'TELEGRAM_BOT');
CREATE TYPE "TrialLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'REJECTED');

CREATE TABLE "TrialLead" (
    "id" TEXT NOT NULL,
    "source" "TrialLeadSource" NOT NULL,
    "status" "TrialLeadStatus" NOT NULL DEFAULT 'NEW',
    "institutionName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "orgType" TEXT,
    "region" TEXT,
    "staffCount" INTEGER,
    "plan" TEXT,
    "billingCycle" TEXT,
    "faceId" BOOLEAN,
    "contactTime" TEXT,
    "telegramChatId" TEXT,
    "telegramUsername" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "pageUrl" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrialLead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrialLead_status_createdAt_idx" ON "TrialLead"("status", "createdAt");
CREATE INDEX "TrialLead_source_createdAt_idx" ON "TrialLead"("source", "createdAt");
CREATE INDEX "TrialLead_phone_idx" ON "TrialLead"("phone");
