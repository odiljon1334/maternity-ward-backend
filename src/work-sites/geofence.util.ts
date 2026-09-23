import { haversineMeters } from '../common/utils/geo.util';

/**
 * Xodim check-in qila oladigan geofence markazlari (FAZA 6, 4b).
 *
 * Qoida — xodim quyidagilarning ISTALGANI ichida bo'lsa ruxsat:
 *  1. unga biriktirilgan faol ish joylari (WorkSite: maktab, bog'cha...);
 *  2. eski, xodim o'zi qo'ygan shaxsiy markaz — admin ko'rib chiqquncha
 *     (tasdiqlansa ish joyiga aylanadi, rad etilsa o'chadi);
 *  3. asosiy bino: lavozim markazi, u bo'lmasa muassasa markazi.
 *
 * Ilgari faqat BITTA markaz ishlatilardi (shaxsiy ?? lavozim ?? muassasa),
 * shuning uchun turli joylarga yo'naltiriladigan xodimlar ishlay olmasdi.
 */
export type GeoCenterSource = 'SITE' | 'PERSONAL' | 'POSITION' | 'HOSPITAL';

export interface GeoCenter {
  lat: number;
  lng: number;
  radius: number;
  name: string;
  source: GeoCenterSource;
  /** Faqat SITE uchun — AttendanceRecord.checkInWorkSiteId ga yoziladi */
  workSiteId: string | null;
}

export interface GeoMatch {
  center: GeoCenter;
  /** Markazgacha masofa (m) */
  distance: number;
  /** Radius + ruxsat etilgan noaniqlik ichidami */
  inside: boolean;
}

type Point = {
  gpsLat?: number | null;
  gpsLng?: number | null;
  gpsRadius?: number | null;
};

export interface GeoCenterInput {
  employee: Point;
  position?: (Point & { name?: string | null }) | null;
  hospital?: (Point & { name?: string | null }) | null;
  /** Xodimga biriktirilgan ish joylari (faol emaslari chiqarib tashlanadi) */
  sites?: Array<{
    id: string;
    name: string;
    gpsLat: number;
    gpsLng: number;
    gpsRadius: number;
    isActive?: boolean;
  }>;
}

const DEFAULT_HOSPITAL_RADIUS = 200;
const DEFAULT_PERSONAL_RADIUS = 100;

const hasPoint = (
  p?: Point | null,
): p is Point & { gpsLat: number; gpsLng: number } =>
  !!p &&
  typeof p.gpsLat === 'number' &&
  typeof p.gpsLng === 'number' &&
  Number.isFinite(p.gpsLat) &&
  Number.isFinite(p.gpsLng);

export function buildGeoCenters(input: GeoCenterInput): GeoCenter[] {
  const centers: GeoCenter[] = [];

  for (const site of input.sites ?? []) {
    if (site.isActive === false) continue;
    if (!hasPoint(site)) continue;
    centers.push({
      lat: site.gpsLat,
      lng: site.gpsLng,
      radius: site.gpsRadius ?? DEFAULT_HOSPITAL_RADIUS,
      name: site.name,
      source: 'SITE',
      workSiteId: site.id,
    });
  }

  if (hasPoint(input.employee)) {
    centers.push({
      lat: input.employee.gpsLat,
      lng: input.employee.gpsLng,
      radius: input.employee.gpsRadius ?? DEFAULT_PERSONAL_RADIUS,
      name: 'Shaxsiy ish joyi (tasdiqlanmagan)',
      source: 'PERSONAL',
      workSiteId: null,
    });
  }

  const hospitalName = input.hospital?.name || 'Asosiy bino';
  if (hasPoint(input.position)) {
    centers.push({
      lat: input.position.gpsLat,
      lng: input.position.gpsLng,
      radius: input.position.gpsRadius ?? DEFAULT_HOSPITAL_RADIUS,
      name: hospitalName,
      source: 'POSITION',
      workSiteId: null,
    });
  } else if (input.hospital && hasPoint(input.hospital)) {
    centers.push({
      lat: input.hospital.gpsLat,
      lng: input.hospital.gpsLng,
      radius: input.hospital.gpsRadius ?? DEFAULT_HOSPITAL_RADIUS,
      name: hospitalName,
      source: 'HOSPITAL',
      workSiteId: null,
    });
  }

  return centers;
}

/**
 * Nuqtaga eng mos markaz — radius chegarasigacha eng yaqin bo'lgani
 * (masofa − radius eng kichik). `toleranceM` — GPS noaniqligi uchun
 * qo'shimcha ruxsat (check-in'da 0, jonli kuzatuvda accuracy).
 */
export function matchGeoCenter(
  centers: GeoCenter[],
  lat: number,
  lng: number,
  toleranceM = 0,
): GeoMatch | null {
  let best: GeoMatch | null = null;
  let bestSlack = Infinity;
  const tolerance = Number.isFinite(toleranceM) ? Math.max(0, toleranceM) : 0;

  for (const center of centers) {
    const distance = haversineMeters(lat, lng, center.lat, center.lng);
    const slack = distance - center.radius;
    if (slack < bestSlack) {
      bestSlack = slack;
      best = { center, distance, inside: slack <= tolerance };
    }
  }
  return best;
}
