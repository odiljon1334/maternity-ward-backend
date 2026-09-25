-- Xodimning shaxsiy Telegram ulanishi va eslatmalar
ALTER TABLE "Employee" ADD COLUMN "telegramLinkedAt" TIMESTAMP(3);
ALTER TABLE "Employee" ADD COLUMN "telegramReminders" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "TelegramLinkToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramLinkToken_tokenHash_key" ON "TelegramLinkToken"("tokenHash");
CREATE INDEX "TelegramLinkToken_employeeId_idx" ON "TelegramLinkToken"("employeeId");
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmployeeReminderLog" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeReminderLog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeReminderLog_employeeId_kind_workDate_key" ON "EmployeeReminderLog"("employeeId", "kind", "workDate");
ALTER TABLE "EmployeeReminderLog" ADD CONSTRAINT "EmployeeReminderLog_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
