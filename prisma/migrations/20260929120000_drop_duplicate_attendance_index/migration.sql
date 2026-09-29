-- (employeeId, workDate) bo'yicha UNIQUE indeks ("AttendanceRecord_employeeId_workDate_key")
-- xuddi shu so'rovlarni qoplaydi; oddiy indeks har yozuvda ortiqcha ish edi.
-- DropIndex
DROP INDEX IF EXISTS "AttendanceRecord_employeeId_workDate_idx";
