-- AttendanceRecord: check-out selfie + GPS maydonlari
ALTER TABLE "AttendanceRecord"
  ADD COLUMN IF NOT EXISTS "checkOutSelfieUrl"   TEXT,
  ADD COLUMN IF NOT EXISTS "checkOutGpsLat"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "checkOutGpsLng"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "checkOutGpsAccuracy" DOUBLE PRECISION;
