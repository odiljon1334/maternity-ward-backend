-- AlterTable
ALTER TABLE "Hospital" ADD COLUMN     "lastPaymentReminderAt" TIMESTAMP(3),
ADD COLUMN     "lastPaymentReminderPeriod" TEXT;
