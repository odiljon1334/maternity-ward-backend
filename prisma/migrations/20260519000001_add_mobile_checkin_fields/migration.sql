-- AttendanceRecord: mobil check-in uchun yangi maydonlar
ALTER TABLE "AttendanceRecord"
  ADD COLUMN IF NOT EXISTS "checkInSource" TEXT DEFAULT 'TERMINAL',
  ADD COLUMN IF NOT EXISTS "selfieUrl"     TEXT,
  ADD COLUMN IF NOT EXISTS "gpsLat"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "gpsLng"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "gpsAccuracy"   DOUBLE PRECISION;

-- Hospital: GPS geofencing uchun yangi maydonlar
ALTER TABLE "Hospital"
  ADD COLUMN IF NOT EXISTS "gpsLat"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "gpsLng"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "gpsRadius" INTEGER DEFAULT 200;
