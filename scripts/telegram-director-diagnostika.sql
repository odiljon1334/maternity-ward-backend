-- ═══════════════════════════════════════════════════════════════════════
--  TELEGRAM: direktor ulana olmayapti — SABABNI ANIQLASH
--  Faqat O'QIYDI. <RAQAM> o'rniga direktor kiritayotgan raqamni yozing.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Raqam bo'yicha xodim topiladimi va ROLI nima?
--    "login_yoq" yoki DIRECTOR/ADMIN dan boshqa rol → "Kirish rad etildi"
SELECT
  e."fullName"                       AS xodim,
  h.name                             AS kasalxona,
  e.phone                            AS bazadagi_raqam,
  regexp_replace(e.phone,'[^0-9]','','g') AS faqat_raqamlar,
  COALESCE(u.role::text,'❌ LOGIN YO''Q') AS roli,
  CASE
    WHEN u.id IS NULL                        THEN '❌ Login yaratilmagan'
    WHEN u.role::text IN ('DIRECTOR','ADMIN') THEN '✅ Ulanishi mumkin'
    ELSE '❌ Roli mos emas (DIRECTOR/ADMIN kerak)'
  END AS xulosa
FROM "Employee" e
LEFT JOIN "User" u     ON u.id = e."userId"
LEFT JOIN "Hospital" h ON h.id = e."hospitalId"
WHERE right(regexp_replace(e.phone,'[^0-9]','','g'), 9)
      = right(regexp_replace('<RAQAM>','[^0-9]','','g'), 9);

-- 2) Har bir kasalxonada DIRECTOR/ADMIN kim? (raqami bormi?)
SELECT h.name AS kasalxona, e."fullName" AS xodim, u.role::text AS roli,
       COALESCE(e.phone,'❌ raqam yo''q') AS raqam
FROM "User" u
JOIN "Employee" e ON e."userId" = u.id
JOIN "Hospital" h ON h.id = e."hospitalId"
WHERE u.role::text IN ('DIRECTOR','ADMIN')
ORDER BY h.name, u.role;

-- 3) Hozir qaysi chatlar qaysi kasalxonaga ulangan?
SELECT t."chatId", t.username, t.role::text AS roli, h.name AS kasalxona, t."isActive"
FROM "TelegramSubscription" t
LEFT JOIN "Hospital" h ON h.id = t."hospitalId"
ORDER BY h.name NULLS FIRST, t."createdAt" DESC;
