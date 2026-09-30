-- Geofence inventarizatsiyasi (reja.md, 1-band)
--
-- Mobil check-in qaysi xodimlarda GPS markazisiz (istalgan joydan) o'tishini
-- ko'rsatadi. Mantiq backend'dagi buildGeoCenters bilan bir xil: xodimda
-- markaz bor, agar quyidagilardan biri bo'lsa —
--   * biriktirilgan faol ish joyi (WorkSite, koordinatasi bilan),
--   * shaxsiy markaz (Employee.gpsLat/gpsLng),
--   * lavozim markazi (Position.gpsLat/gpsLng),
--   * muassasaning asosiy binosi (Hospital.gpsLat/gpsLng).
--
-- Ishga tushirish (serverda):
--   docker exec -i maternity_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < scripts/geofence-inventory.sql
--
-- Faqat o'qiydi, hech narsani o'zgartirmaydi.

WITH emp AS (
  SELECT
    e.id,
    e."hospitalId",
    (e."gpsLat" IS NOT NULL AND e."gpsLng" IS NOT NULL) AS has_personal,
    (p."gpsLat" IS NOT NULL AND p."gpsLng" IS NOT NULL) AS has_position,
    EXISTS (
      SELECT 1
      FROM "EmployeeWorkSite" ews
      JOIN "WorkSite" ws ON ws.id = ews."workSiteId"
      WHERE ews."employeeId" = e.id AND ws."isActive" = true
    ) AS has_site
  FROM "Employee" e
  LEFT JOIN "Position" p ON p.id = e."positionId"
  WHERE e."firedAt" IS NULL
    AND e."userId" IS NOT NULL -- mobil ilovaga kira oladiganlar
)
SELECT
  h.code AS "kod",
  h.name AS "muassasa",
  (h."gpsLat" IS NOT NULL AND h."gpsLng" IS NOT NULL) AS "asosiy_bino_bor",
  (SELECT count(*) FROM "WorkSite" ws WHERE ws."hospitalId" = h.id AND ws."isActive") AS "faol_ish_joylari",
  count(emp.id) AS "ilovali_xodimlar",
  count(emp.id) FILTER (
    WHERE NOT (
      emp.has_site OR emp.has_personal OR emp.has_position
      OR (h."gpsLat" IS NOT NULL AND h."gpsLng" IS NOT NULL)
    )
  ) AS "markazsiz_xodimlar"
FROM "Hospital" h
LEFT JOIN emp ON emp."hospitalId" = h.id
WHERE h."isActive" = true
GROUP BY h.id
ORDER BY "markazsiz_xodimlar" DESC, h.name;
