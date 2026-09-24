-- Parol tiklash OTP'si uchun noto'g'ri urinishlar hisoblagichi
ALTER TABLE "PasswordResetToken" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
