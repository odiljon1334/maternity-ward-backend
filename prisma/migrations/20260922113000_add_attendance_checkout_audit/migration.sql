ALTER TABLE "AttendanceRecord"
ADD COLUMN "checkOutSource" TEXT,
ADD COLUMN "autoCheckOut" BOOLEAN NOT NULL DEFAULT false;
