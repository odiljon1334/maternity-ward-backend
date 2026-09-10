-- ═══════════════════════════════════════════════════════════════════════
--  TELEGRAM "vaqtida kelmadi" SHIKOYATI — DIAGNOSTIKA
--  Production bazada ishga tushiring (faqat O'QIYDI, hech narsa o'zgartirmaydi)
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Terminal YUBORGAN xom vaqt va biz SAQLAGAN vaqt yonma-yon.
--    Agar "terminal_aytgan" bilan "biz_saqladik_toshkent" farq qilsa —
--    terminal soati yoki timezone sozlamasi noto'g'ri.
SELECT
  e."fullName"                                   AS xodim,
  ev."rawTime" AT TIME ZONE 'Asia/Tashkent'      AS biz_saqladik_toshkent,
  ev."rawPayload" #>> '{dateTime}'               AS terminal_aytgan_1,
  ev."rawPayload" #>> '{AccessControllerEvent,dateTime}' AS terminal_aytgan_2,
  ev."eventType",
  ev."deviceName"
FROM "AttendanceEvent" ev
JOIN "Employee" e ON e.id = ev."employeeId"
WHERE ev."rawTime" >= now() - interval '3 days'
ORDER BY ev."rawTime" DESC
LIMIT 40;


-- 2) Ertalab 06:00–09:00 orasida kelganlar kech deb belgilanganmi?
--    "kutilgan" ustuni 07:00 dan oldin bo'lsa — smena vaqti sabab.
--    "keldi" ustuni haqiqiy kelish vaqtidan farq qilsa — timezone sabab.
SELECT
  e."fullName"                                AS xodim,
  a."checkIn"  AT TIME ZONE 'Asia/Tashkent'   AS keldi,
  a."expectedCheckIn" AT TIME ZONE 'Asia/Tashkent' AS kutilgan,
  a."lateMinutes"                             AS kechikish_daq,
  a.status,
  s."startTime" || '-' || s."endTime"         AS smena
FROM "AttendanceRecord" a
JOIN "Employee" e ON e.id = a."employeeId"
LEFT JOIN "Schedule" sc ON sc.id = a."scheduleId"
LEFT JOIN "ShiftTemplate" s ON s.id = sc."shiftId"
WHERE a."checkIn" IS NOT NULL
  AND a."workDate" >= now() - interval '7 days'
  AND EXTRACT(hour FROM a."checkIn" AT TIME ZONE 'Asia/Tashkent') BETWEEN 6 AND 9
ORDER BY a."lateMinutes" DESC
LIMIT 40;


-- 3) Terminal qanday status yuboryapti? (CHECK_IN o'rniga CHECK_OUT kelsa,
--    ertalabki birinchi o'tish umuman yozilmaydi va xabar ham bormaydi)
SELECT ev."eventType", count(*) AS soni
FROM "AttendanceEvent" ev
WHERE ev."rawTime" >= now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC;
