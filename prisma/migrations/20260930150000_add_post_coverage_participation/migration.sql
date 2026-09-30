ALTER TABLE "MonthlyScheduleEntry"
  ADD COLUMN "countsTowardPostCoverage" BOOLEAN NOT NULL DEFAULT true;

-- Mavjud production grafiklari oldingi hisob-kitobini saqlab qoladi:
-- barcha eski yozuvlar post qamroviga kirishda davom etadi.
