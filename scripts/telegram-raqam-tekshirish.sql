-- ═══════════════════════════════════════════════════════════════════════
--  TELEGRAM: "raqamli hodim tizimda topilmadi" — SABABNI TOPISH
--  Faqat O'QIYDI.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Direktorlar raqami bazada QANDAY saqlangan?
--    uzunlik va "koriniwi" ustunlariga qarang: ortiqcha bo'shliq yoki
--    ko'rinmas belgi bo'lsa, eski qidiruv (endsWith) ishlamaydi.
SELECT
  h.name                                   AS kasalxona,
  e."fullName"                             AS direktor,
  e.phone                                  AS raqam,
  length(e.phone)                          AS uzunlik,
  '['||e.phone||']'                        AS korinishi,      -- qavs ichida bo'shliq ko'rinadi
  regexp_replace(e.phone,'[^0-9]','','g')  AS faqat_raqamlar,
  right(regexp_replace(e.phone,'[^0-9]','','g'),9) AS oxirgi_9,
  -- Eski kod shu shart bilan qidirardi:
  (e.phone LIKE '%996338808')              AS eski_kod_topadimi,
  u.role::text                             AS roli
FROM "User" u
JOIN "Employee" e ON e."userId" = u.id
JOIN "Hospital" h ON h.id = e."hospitalId"
WHERE u.role::text IN ('DIRECTOR','ADMIN')
ORDER BY h.name;


-- 2) Aniq bir raqam bo'yicha: eski va yangi usul solishtiriladi
--    (996338808 o'rniga kerakli oxirgi 9 raqamni qo'ying)
SELECT
  e."fullName"                     AS xodim,
  h.name                           AS kasalxona,
  e.phone                          AS raqam,
  (e.phone LIKE '%996338808')      AS eski_usul,
  (right(regexp_replace(e.phone,'[^0-9]','','g'),9) = '996338808') AS yangi_usul,
  COALESCE(u.role::text,'LOGIN YO''Q') AS roli
FROM "Employee" e
LEFT JOIN "User" u     ON u.id = e."userId"
LEFT JOIN "Hospital" h ON h.id = e."hospitalId"
WHERE right(regexp_replace(e.phone,'[^0-9]','','g'),9) = '996338808'
   OR e.phone LIKE '%996338808';


-- 3) Umuman: nechta xodim raqami "toza" formatda emas?
SELECT
  count(*) FILTER (WHERE phone ~ '^\+998[0-9]{9}$')  AS toza_format,
  count(*) FILTER (WHERE phone IS NOT NULL
                     AND phone !~ '^\+998[0-9]{9}$') AS notoza_format,
  count(*) FILTER (WHERE phone IS NULL)              AS raqamsiz
FROM "Employee" WHERE "firedAt" IS NULL;
