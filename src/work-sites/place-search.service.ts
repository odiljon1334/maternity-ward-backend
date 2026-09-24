import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { haversineMeters } from '../common/utils/geo.util';
import {
  buildQueryVariants,
  LatLng,
  normalizeQuery,
  parseCoordinates,
} from './place-search.util';

export type PlaceSource = 'COORDS' | 'YANDEX_ORG' | 'YANDEX_GEO' | 'OSM';

export interface PlaceResult {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  source: PlaceSource;
  /** Muassasa markazidan masofa (metr) — tartiblash va ko'rsatish uchun */
  distance: number | null;
}

/** Muassasa markazi belgilanmagan bo'lsa qidiruv shu nuqta atrofida (Andijon) */
const DEFAULT_NEAR: LatLng = { lat: 40.7821, lng: 72.3442 };
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const HTTP_TIMEOUT_MS = 6000;
/** Nominatim foydalanish qoidasi: sekundiga ko'pi bilan 1 so'rov */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const USER_LIMIT_PER_MIN = 20;
const MAX_RESULTS = 8;
/** Bir joy turli manbadan kelsa — shu masofadan yaqin natijalar birlashtiriladi */
const DEDUPE_M = 40;

/**
 * Ish joyi manzilini nomi bo'yicha qidirish (Sozlamalar → Ish joylari).
 *
 * Manbalar (natijalar birlashtiriladi, muassasa markaziga yaqinlari oldinda):
 *  1. Koordinata yoki xarita havolasi — tarmoqsiz, darhol.
 *  2. Yandex qidiruv API (`YANDEX_SEARCH_API_KEY` bo'lsa) — tashkilotlar
 *     (maktab, bog'cha...) VA manzillar bitta so'rovda; O'zbekiston uchun
 *     eng to'liq baza.
 *  3. Yandex geokoder (`YANDEX_GEOCODER_API_KEY` bo'lsa, ixtiyoriy) —
 *     qo'shimcha ko'cha/uy manzili.
 *  4. OpenStreetMap (Nominatim) — kalitsiz, bepul; foydalanish qoidasiga
 *     ko'ra sekundiga 1 so'rov, natijalar 24 soat keshlanadi.
 */
@Injectable()
export class PlaceSearchService {
  private readonly logger = new Logger(PlaceSearchService.name);
  private readonly cache = new Map<
    string,
    { at: number; results: PlaceResult[] }
  >();
  private readonly userHits = new Map<string, number[]>();
  private nominatimChain: Promise<unknown> = Promise.resolve();
  private nominatimLastAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async search(
    rawQuery: string,
    hospitalId: string,
    userId: string,
  ): Promise<PlaceResult[]> {
    const query = normalizeQuery(rawQuery ?? '');
    if (query.length < 2) return [];

    const near = await this.hospitalCenter(hospitalId);

    const coords = parseCoordinates(rawQuery);
    if (coords) {
      return [
        {
          name: "Ko'rsatilgan nuqta",
          address: `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`,
          lat: coords.lat,
          lng: coords.lng,
          source: 'COORDS',
          distance: Math.round(
            haversineMeters(near.lat, near.lng, coords.lat, coords.lng),
          ),
        },
      ];
    }

    const cacheKey = `${query.toLowerCase()}|${near.lat.toFixed(2)},${near.lng.toFixed(2)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results;

    this.checkUserLimit(userId);

    const [yandexOrg, yandexGeo] = await Promise.all([
      this.yandexOrganizations(query, near),
      this.yandexGeocoder(query, near),
    ]);
    let osm: PlaceResult[] = [];
    // OSM faqat Yandex qidiruv hech narsa bermagan bo'lsa (tezlik va qoida uchun)
    if (!yandexOrg.length && process.env.GEO_OSM_DISABLED !== 'true') {
      for (const variant of buildQueryVariants(query)) {
        osm = await this.nominatim(variant, near);
        if (osm.length) break;
      }
    }

    const results = this.mergeAndRank(
      [...yandexOrg, ...yandexGeo, ...osm],
      near,
    );
    this.remember(cacheKey, results);
    return results;
  }

  // ── Manbalar ────────────────────────────────────────────────────────────────

  private async yandexOrganizations(
    q: string,
    near: LatLng,
  ): Promise<PlaceResult[]> {
    const apikey = process.env.YANDEX_SEARCH_API_KEY;
    if (!apikey) return [];
    // `type` berilmaydi — tashkilotlar (biz) ham, manzillar (geo) ham qaytadi,
    // shuning uchun alohida geokoder kaliti shart emas. Til: uz_UZ qo'llanmasa
    // (400) — ru_RU bilan qayta so'raladi.
    for (const lang of ['uz_UZ', 'ru_RU']) {
      try {
        const { data } = await axios.get('https://search-maps.yandex.ru/v1/', {
          params: {
            apikey,
            text: q,
            lang,
            ll: `${near.lng},${near.lat}`,
            spn: '1.0,1.0',
            results: MAX_RESULTS,
          },
          timeout: HTTP_TIMEOUT_MS,
        });
        return (data?.features ?? [])
          .map((f: any): PlaceResult | null => {
            const [lng, lat] = f?.geometry?.coordinates ?? [];
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            const props = f?.properties ?? {};
            const isOrg = !!props.CompanyMetaData;
            return {
              name: String(props.name ?? q),
              address: isOrg
                ? (props.CompanyMetaData?.address ?? props.description ?? null)
                : (props.GeocoderMetaData?.text ?? props.description ?? null),
              lat,
              lng,
              source: isOrg ? 'YANDEX_ORG' : 'YANDEX_GEO',
              distance: null,
            };
          })
          .filter(Boolean) as PlaceResult[];
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 400 && lang !== 'ru_RU') continue;
        this.logger.warn(
          `Yandex qidiruv API ishlamadi${status ? ` (HTTP ${status}${status === 403 ? ' — kalit, uning ruxsatlari yoki kunlik limitini tekshiring' : ''})` : ''}: ${this.errText(e)}`,
        );
        return [];
      }
    }
    return [];
  }

  private async yandexGeocoder(
    q: string,
    near: LatLng,
  ): Promise<PlaceResult[]> {
    const apikey = process.env.YANDEX_GEOCODER_API_KEY;
    if (!apikey) return [];
    try {
      const { data } = await axios.get('https://geocode-maps.yandex.ru/1.x/', {
        params: {
          apikey,
          geocode: q,
          format: 'json',
          lang: 'uz_UZ',
          ll: `${near.lng},${near.lat}`,
          spn: '1.0,1.0',
          results: 5,
        },
        timeout: HTTP_TIMEOUT_MS,
      });
      const members = data?.response?.GeoObjectCollection?.featureMember ?? [];
      return members
        .map((m: any): PlaceResult | null => {
          const obj = m?.GeoObject;
          const [lng, lat] = String(obj?.Point?.pos ?? '')
            .split(' ')
            .map(Number);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          return {
            name: String(obj?.name ?? q),
            address: obj?.description ?? null,
            lat,
            lng,
            source: 'YANDEX_GEO',
            distance: null,
          };
        })
        .filter(Boolean) as PlaceResult[];
    } catch (e) {
      this.logger.warn(`Yandex geokoder ishlamadi: ${this.errText(e)}`);
      return [];
    }
  }

  /** Nominatim — global navbat bilan (sekundiga ≤ 1 so'rov, bir nechta foydalanuvchi bo'lsa ham) */
  private nominatim(q: string, near: LatLng): Promise<PlaceResult[]> {
    const run = async (): Promise<PlaceResult[]> => {
      const wait =
        this.nominatimLastAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nominatimLastAt = Date.now();
      try {
        const d = 0.6;
        const { data } = await axios.get(
          'https://nominatim.openstreetmap.org/search',
          {
            params: {
              q,
              format: 'jsonv2',
              countrycodes: 'uz',
              limit: MAX_RESULTS,
              'accept-language': 'uz,ru',
              viewbox: `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`,
              bounded: 0,
              ...(process.env.GEO_CONTACT_EMAIL && {
                email: process.env.GEO_CONTACT_EMAIL,
              }),
            },
            headers: {
              // Nominatim qoidasi: ilovani aniqlaydigan User-Agent majburiy
              'User-Agent': `StaffPlusPRO/1.0 (+${process.env.FRONTEND_URL || 'https://clinicuk24.com'})`,
            },
            timeout: HTTP_TIMEOUT_MS,
          },
        );
        return (Array.isArray(data) ? data : [])
          .map((r: any): PlaceResult | null => {
            const lat = Number(r?.lat);
            const lng = Number(r?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            const display = String(r?.display_name ?? '');
            const name = String(r?.name || display.split(',')[0] || q).trim();
            return {
              name,
              address: display || null,
              lat,
              lng,
              source: 'OSM',
              distance: null,
            };
          })
          .filter(Boolean) as PlaceResult[];
      } catch (e) {
        this.logger.warn(
          `OSM (Nominatim) qidiruvi ishlamadi: ${this.errText(e)}`,
        );
        return [];
      }
    };
    const next = this.nominatimChain.then(run, run);
    this.nominatimChain = next.catch(() => undefined);
    return next;
  }

  // ── Yordamchilar ────────────────────────────────────────────────────────────

  private async hospitalCenter(hospitalId: string): Promise<LatLng> {
    const h = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { gpsLat: true, gpsLng: true },
    });
    return h?.gpsLat != null && h?.gpsLng != null
      ? { lat: h.gpsLat, lng: h.gpsLng }
      : DEFAULT_NEAR;
  }

  /** Dublikatlarni birlashtiradi, masofani qo'yadi, yaqinini oldinga chiqaradi */
  mergeAndRank(items: PlaceResult[], near: LatLng): PlaceResult[] {
    const out: PlaceResult[] = [];
    for (const it of items) {
      const dup = out.find(
        (o) => haversineMeters(o.lat, o.lng, it.lat, it.lng) < DEDUPE_M,
      );
      if (dup) continue; // birinchi (ishonchliroq) manba qoladi
      out.push({
        ...it,
        distance: Math.round(
          haversineMeters(near.lat, near.lng, it.lat, it.lng),
        ),
      });
    }
    // Manba ustuvorligi saqlanadi, lekin 50 km dan uzoq natijalar oxiriga tushadi
    const far = 50_000;
    return out
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const af = (a.r.distance ?? 0) > far ? 1 : 0;
        const bf = (b.r.distance ?? 0) > far ? 1 : 0;
        return af - bf || a.i - b.i;
      })
      .map((x) => x.r)
      .slice(0, MAX_RESULTS);
  }

  private remember(key: string, results: PlaceResult[]) {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), results });
  }

  private checkUserLimit(userId: string) {
    const now = Date.now();
    const hits = (this.userHits.get(userId) ?? []).filter(
      (t) => now - t < 60_000,
    );
    if (hits.length >= USER_LIMIT_PER_MIN) {
      throw new HttpException(
        "Juda ko'p qidiruv. Bir daqiqadan so'ng qayta urinib ko'ring.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    hits.push(now);
    this.userHits.set(userId, hits);
  }

  private errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
