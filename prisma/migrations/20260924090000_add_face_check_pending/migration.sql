-- Yuz tekshiruvi kechiktirilgan check-in'lar (xizmat ishlamay qolsa davomat to'xtamaydi)
ALTER TABLE "AttendanceRecord" ADD COLUMN "faceCheckPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AttendanceRecord" ADD COLUMN "faceCheckReason" TEXT;

CREATE INDEX "AttendanceRecord_faceCheckPending_workDate_idx" ON "AttendanceRecord"("faceCheckPending", "workDate");
