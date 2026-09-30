CREATE TYPE "SchedulePostCoverageMode" AS ENUM (
  'CONTINUOUS_24_7',
  'DAILY',
  'WEEKDAYS',
  'CUSTOM_WEEKLY'
);

ALTER TABLE "SchedulePost"
  ADD COLUMN "coverageMode" "SchedulePostCoverageMode" NOT NULL DEFAULT 'CONTINUOUS_24_7',
  ADD COLUMN "coverageMinutesByWeekday" JSONB;

ALTER TABLE "MonthlySchedulePlan"
  ADD COLUMN "coverageMode" "SchedulePostCoverageMode" NOT NULL DEFAULT 'CONTINUOUS_24_7',
  ADD COLUMN "dailyCoverageMinutes" INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN "coverageMinutesByWeekday" JSONB;

-- Mavjud rejalar o'z posti uchun deploy paytidagi normani snapshot qiladi.
-- Bu eski tasdiqlangan grafiklarning hisobini keyingi post sozlamalaridan ajratadi.
UPDATE "MonthlySchedulePlan" AS plan
SET "dailyCoverageMinutes" = post."dailyCoverageMinutes"
FROM "SchedulePost" AS post
WHERE plan."postId" = post."id";

ALTER TABLE "MonthlySchedulePlan"
  ADD CONSTRAINT "MonthlySchedulePlan_dailyCoverageMinutes_check"
  CHECK ("dailyCoverageMinutes" BETWEEN 1 AND 1440);
