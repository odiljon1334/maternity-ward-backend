-- Bo'sh smena smena boshlanganidan keyin tasdiqlansa, o'rinbosarning
-- kechikishi tasdiqlangan vaqtdan (+ yo'l uchun) hisoblanadi.
-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "expectedStartAt" TIMESTAMP(3);
