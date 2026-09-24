import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  /**
   * Geosaggest natijalarida koordinata bo'lmaydi (lat/lng = null, `uri` bor):
   * foydalanuvchi tanlaganda `resolve(uri)` bilan geokoderdan olinadi. Shunda
   * har qidiruvda 7 ta emas, faqat tanlangan joy uchun 1 ta geokoder so'rovi ketadi.
   */
  lat: number | null;
  lng: number | null;
  source: PlaceSource;
  /** Muassasa markazidan masofa (metr) — tartiblash va ko'rsatish uchun */
  distance: number | null;
  uri?: string | null;
}

export type ResolvedPlace = PlaceResult & { lat: number; lng: number };

/** Muassasa markazi belgilanmagan bo'lsa qidiruv shu nuqta atrofida (Andijon) */
const DEFAULT_NEAR: LatLng = { lat: 40.7821, lng: 72.3442 };
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Yandex shartlari natijalarni saqlashni taqiqlaydi — ular faqat qisqa vaqt
 * (takroriy bosishlardan himoya uchun) xotirada turadi. OSM natijalari 24 soat.
 */
const YANDEX_CACHE_TTL_MS = 10 * 60 * 1000;
/** Har bir Yandex mahsuloti uchun kunlik so'rov chegarasi (bepul tarif 1000) */
const DEFAULT_YANDEX_DAILY_CAP = 900;
const RESOLVE_LIMIT_PER_MIN = 30;
const SUGGEST_URI_RE = /^ymapsbm1:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+$/;
const CACHE_MAX = 500;
const HTTP_TIMEOUT_MS = 6000;
/** Nominatim foydalanish qoidasi: sekundiga ko'pi bilan 1 so'rov */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const USER_LIMIT_PER_MIN = 20;
const MAX_RESULTS = 8;
/** Bir joy turli manbadan kelsa — shu masofadan yaqin natijalar birlashtiriladi */
const DEDUPE_M = 40;
/** Geosaggest bergan uri shuncha vaqt tanlash uchun yaroqli */
const ISSUED_URI_TTL_MS = 30 * 60 * 1000;
/** Butun qidiruv uchun vaqt byudjeti (frontend 15 s kutadi) */
const SEARCH_BUDGET_MS = 11_000;
/** Nominatim navbatida shundan ko'p kutayotgan bo'lsa OSM o'tkazib yuboriladi */
const NOMINATIM_MAX_QUEUE = 3;
/** Qidiruv matni (koordinata/havola emas) uzunligi */
const MAX_TEXT_QUERY = 200;
const YANDEX_LANGS = new Set([
  'ru_RU',
  'en_RU',
  'en_US',
  'uk_UA',
  'be_BY',
  'tr_TR',
]);

/**
 * Ish joyi manzilini nomi bo'yicha qidirish (Sozlamalar → Ish joylari).
 *
 * Manbalar (natijalar birlashtiriladi, muassasa markaziga yaqinlari oldinda):
 *  1. Koordinata yoki xarita havolasi — tarmoqsiz, darhol.
 *  2. Yandex Geosaggest (`YANDEX_SUGGEST_API_KEY` + `YANDEX_GEOCODER_API_KEY`)
 *     — bepul tarif: tashkilotlar (maktab, bog'cha...) va manzillar. Koordinata
 *     tanlanganda geokoder orqali `uri` bo'yicha olinadi (`resolve`).
 *  3. Yandex tashkilot qidiruvi (`YANDEX_SEARCH_API_KEY`, pullik, ixtiyoriy).
 *  4. Yandex geokoder matn bo'yicha — Geosaggest hech narsa bermasa yoki
 *     uning kaliti bo'lmasa.
 *  5. OpenStreetMap (Nominatim) — kalitsiz, bepul; foydalanish qoidasiga
 *     ko'ra sekundiga 1 so'rov, natijalar 24 soat keshlanadi.
 *
 * Har bir Yandex mahsulotiga kunlik chegara qo'yilgan (`YANDEX_DAILY_CAP`,
 * standart 900): bepul limitdan muntazam oshish kalitning butunlay
 * bloklanishiga olib keladi, chegaraga yetganda faqat OSM ishlaydi.
 */
@Injectable()
export class PlaceSearchService {
  private readonly logger = new Logger(PlaceSearchService.name);
  private readonly cache = new Map<
    string,
    { at: number; ttl: number; results: PlaceResult[] }
  >();
  private readonly resolved = new Map<
    string,
    { at: number; place: ResolvedPlace }
  >();
  private readonly userHits = new Map<string, number[]>();
  private readonly quota = new Map<string, { day: string; used: number }>();
  /** Geosaggest bergan uri'lar (uri → {at, hospitalId}) — faqat shular aniqlanadi */
  private readonly issuedUris = new Map<
    string,
    { at: number; hospitalId: string }
  >();
  private nominatimPending = 0;
  private nominatimChain: Promise<unknown> = Promise.resolve();
  private nominatimLastAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async search(
    rawQuery: string,
    hospitalId: string,
    userId: string,
  ): Promise<PlaceResult[]> {
    const raw = String(rawQuery ?? '');
    const near = await this.hospitalCenter(hospitalId);

    // Havola uzun bo'lishi mumkin — koordinata avval to'liq matndan olinadi
    const coords = parseCoordinates(raw);
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

    const query = normalizeQuery(raw.slice(0, MAX_TEXT_QUERY));
    if (query.length < 2) return [];
    const startedAt = Date.now();

    const cacheKey = `${query.toLowerCase()}|${near.lat.toFixed(2)},${near.lng.toFixed(2)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.results;

    this.checkUserLimit(userId);

    const [suggest, places] = await Promise.all([
      this.yandexSuggest(query, near),
      this.yandexOrganizations(query, near),
    ]);
    // Geokoder matn qidiruvi faqat Geosaggest/qidiruv hech narsa bermasa —
    // kunlik limit tanlangan joy koordinatasi (resolve) uchun asraladi.
    const geo =
      suggest.length || places.length
        ? []
        : await this.yandexGeocoder(query, near);
    const yandex = [...suggest, ...places, ...geo];

    let osm: PlaceResult[] = [];
    let osmAnswered = false;
    // OSM faqat Yandex tashkilot topmagan bo'lsa (tezlik va foydalanish
    // qoidasi uchun). Vaqt byudjeti tugasa yoki navbat uzun bo'lsa — o'tkaziladi.
    const hasOrg = yandex.some((r) => r.source === 'YANDEX_ORG');
    if (!hasOrg && process.env.GEO_OSM_DISABLED !== 'true') {
      for (const variant of buildQueryVariants(query)) {
        const left = SEARCH_BUDGET_MS - (Date.now() - startedAt);
        if (left < 2500 || this.nominatimPending >= NOMINATIM_MAX_QUEUE) break;
        const r = await this.nominatim(variant, near, left - 500);
        if (r === null) break; // xato — keyingi variant ham ishlamaydi
        osmAnswered = true;
        osm = r;
        if (osm.length) break;
      }
    }

    const results = this.mergeAndRank([...yandex, ...osm], near);
    for (const r of results) {
      if (r.uri) this.issueUri(r.uri, hospitalId);
    }
    // Bo'sh natija keshlanmaydi (tarmoq uzilishi so'rovni bir kunga
    // "topilmadi" qilib qo'ymasin). Yandex natijalari qisqa muddat.
    if (results.length) {
      this.remember(
        cacheKey,
        results,
        yandex.length || !osmAnswered ? YANDEX_CACHE_TTL_MS : CACHE_TTL_MS,
      );
    }
    return results;
  }

  private issueUri(uri: string, hospitalId: string) {
    const now = Date.now();
    if (this.issuedUris.size > 5000) {
      for (const [k, v] of this.issuedUris) {
        if (now - v.at > ISSUED_URI_TTL_MS) this.issuedUris.delete(k);
      }
      if (this.issuedUris.size > 5000) {
        const oldest = this.issuedUris.keys().next().value;
        if (oldest !== undefined) this.issuedUris.delete(oldest);
      }
    }
    this.issuedUris.delete(uri);
    this.issuedUris.set(uri, { at: now, hospitalId });
  }

  /**
   * Geosaggest natijasining koordinatasi — foydalanuvchi ro'yxatdan joy
   * tanlaganda chaqiriladi (geokoder `uri` parametri).
   */
  async resolve(
    rawUri: string,
    hospitalId: string,
    userId: string,
  ): Promise<ResolvedPlace> {
    const uri = String(rawUri ?? '').trim();
    if (!uri || uri.length > 2000 || !SUGGEST_URI_RE.test(uri)) {
      throw new BadRequestException("Noto'g'ri joy identifikatori");
    }
    const apikey = process.env.YANDEX_GEOCODER_API_KEY;
    if (!apikey) {
      throw new ServiceUnavailableException(
        'Joy koordinatasini aniqlash sozlanmagan. Nuqtani xaritadan tanlang.',
      );
    }
    // Faqat shu muassasa uchun yaqinda qidiruvda berilgan uri — aks holda
    // istalgan satr bilan umumiy kunlik geokoder limitini tugatish mumkin edi
    const issued = this.issuedUris.get(uri);
    if (
      !issued ||
      issued.hospitalId !== hospitalId ||
      Date.now() - issued.at > ISSUED_URI_TTL_MS
    ) {
      throw new BadRequestException(
        'Qidiruv natijasi eskirgan. Qidiruvni qaytadan bajaring.',
      );
    }
    const near = await this.hospitalCenter(hospitalId);
    const hit = this.resolved.get(uri);
    if (hit && Date.now() - hit.at < YANDEX_CACHE_TTL_MS) {
      return this.withDistance(hit.place, near);
    }

    this.checkUserLimit(`${userId}:resolve`, RESOLVE_LIMIT_PER_MIN);
    if (!this.takeQuota('geocoder')) {
      throw new ServiceUnavailableException(
        "Bugungi manzil aniqlash limiti tugadi. Nuqtani xaritadan tanlang yoki xarita havolasini qo'ying.",
      );
    }

    let obj: any;
    try {
      const { data } = await axios.get('https://geocode-maps.yandex.ru/1.x/', {
        params: { apikey, uri, format: 'json', lang: this.lang(), results: 1 },
        timeout: HTTP_TIMEOUT_MS,
      });
      obj = data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
    } catch (e) {
      this.warnHttp('Yandex geokoder (uri)', e);
      throw new ServiceUnavailableException(
        "Joy koordinatasini olib bo'lmadi. Birozdan so'ng urinib ko'ring yoki nuqtani xaritadan tanlang.",
      );
    }
    const place = this.fromGeoObject(obj, 'YANDEX_GEO');
    if (!place) {
      throw new NotFoundException(
        'Bu joyning koordinatasi topilmadi. Nuqtani xaritadan tanlang.',
      );
    }
    this.resolved.set(uri, { at: Date.now(), place });
    if (this.resolved.size > CACHE_MAX) {
      const oldest = this.resolved.keys().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
    return this.withDistance(place, near);
  }

  // ── Manbalar ────────────────────────────────────────────────────────────────

  /** Yandex Geosaggest — tashkilot va manzillar, koordinatasiz (`uri` bilan) */
  private async yandexSuggest(q: string, near: LatLng): Promise<PlaceResult[]> {
    const apikey = process.env.YANDEX_SUGGEST_API_KEY;
    // uri → koordinata uchun geokoder kerak; usiz natijani ishlatib bo'lmaydi
    if (!apikey || !process.env.YANDEX_GEOCODER_API_KEY) return [];
    if (!this.takeQuota('suggest')) return [];
    try {
      const ll = `${near.lng},${near.lat}`;
      const { data } = await axios.get(
        'https://suggest-maps.yandex.ru/v1/suggest',
        {
          params: {
            apikey,
            text: q,
            lang: this.lang().slice(0, 2),
            ll,
            ull: ll,
            spn: '1.0,1.0',
            types: 'biz,geo',
            print_address: 1,
            attrs: 'uri',
            highlight: 0,
            results: MAX_RESULTS,
          },
          timeout: HTTP_TIMEOUT_MS,
        },
      );
      return (data?.results ?? [])
        .map((r: any): PlaceResult | null => {
          const uri = typeof r?.uri === 'string' ? r.uri : null;
          const name = String(r?.title?.text ?? '').trim();
          if (!uri || !name) return null;
          const tags: string[] = Array.isArray(r?.tags) ? r.tags : [];
          const dist = Number(r?.distance?.value);
          return {
            name,
            address: r?.address?.formatted_address ?? r?.subtitle?.text ?? null,
            lat: null,
            lng: null,
            source: tags.includes('business') ? 'YANDEX_ORG' : 'YANDEX_GEO',
            distance: Number.isFinite(dist) ? Math.round(dist) : null,
            uri,
          };
        })
        .filter(Boolean) as PlaceResult[];
    } catch (e) {
      this.warnHttp('Yandex Geosaggest', e);
      return [];
    }
  }

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
      if (!this.takeQuota('search')) return [];
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
        this.warnHttp('Yandex tashkilot qidiruvi', e);
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
    if (!apikey || !this.takeQuota('geocoder')) return [];
    try {
      const { data } = await axios.get('https://geocode-maps.yandex.ru/1.x/', {
        params: {
          apikey,
          geocode: q,
          format: 'json',
          // Geokoder uz_UZ ni qo'llamaydi (ru_RU, en_RU, en_US, uk_UA, be_BY, tr_TR)
          lang: this.lang(),
          ll: `${near.lng},${near.lat}`,
          spn: '1.0,1.0',
          results: 5,
        },
        timeout: HTTP_TIMEOUT_MS,
      });
      const members = data?.response?.GeoObjectCollection?.featureMember ?? [];
      return members
        .map((m: any) => this.fromGeoObject(m?.GeoObject, 'YANDEX_GEO'))
        .filter(Boolean) as PlaceResult[];
    } catch (e) {
      this.warnHttp('Yandex geokoder', e);
      return [];
    }
  }

  /** Nominatim — global navbat bilan (sekundiga ≤ 1 so'rov, bir nechta foydalanuvchi bo'lsa ham) */
  /** null — xizmat javob bermadi (xato/timeout), [] — hech narsa topilmadi */
  private nominatim(
    q: string,
    near: LatLng,
    timeoutMs = HTTP_TIMEOUT_MS,
  ): Promise<PlaceResult[] | null> {
    const run = async (): Promise<PlaceResult[] | null> => {
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
            timeout: Math.max(1000, Math.min(HTTP_TIMEOUT_MS, timeoutMs)),
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
        return null;
      }
    };
    this.nominatimPending++;
    const next = this.nominatimChain
      .then(run, run)
      .finally(() => this.nominatimPending--);
    this.nominatimChain = next.catch(() => undefined);
    return next;
  }

  // ── Yordamchilar ────────────────────────────────────────────────────────────

  /** Yandex javob tili (geokoder formati). Standart ru_RU. */
  private lang(): string {
    const l = (process.env.YANDEX_MAPS_LANG || 'ru_RU').trim();
    return YANDEX_LANGS.has(l) ? l : 'ru_RU';
  }

  private fromGeoObject(obj: any, source: PlaceSource): ResolvedPlace | null {
    const [lng, lat] = String(obj?.Point?.pos ?? '')
      .split(' ')
      .map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const meta = obj?.metaDataProperty?.GeocoderMetaData;
    return {
      name: String(obj?.name ?? meta?.text ?? '').trim() || 'Tanlangan joy',
      address: meta?.text ?? obj?.description ?? null,
      lat,
      lng,
      source,
      distance: null,
    };
  }

  private withDistance(p: ResolvedPlace, near: LatLng): ResolvedPlace {
    return {
      ...p,
      distance: Math.round(haversineMeters(near.lat, near.lng, p.lat, p.lng)),
    };
  }

  /**
   * Kunlik chegara (Toshkent kuni bo'yicha, jarayon xotirasida). Chegaraga
   * yetganda `false` — chaqiruvchi o'sha manbani o'tkazib yuboradi.
   */
  private takeQuota(product: string): boolean {
    const cap =
      Number(process.env.YANDEX_DAILY_CAP) || DEFAULT_YANDEX_DAILY_CAP;
    const day = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    const q = this.quota.get(product);
    const cur = q && q.day === day ? q : { day, used: 0 };
    if (cur.used >= cap) {
      if (cur.used === cap) {
        this.logger.warn(
          `Yandex ${product}: kunlik chegara (${cap}) tugadi — ertagacha faqat zaxira manbalar`,
        );
        cur.used++; // ogohlantirish bir marta
      }
      this.quota.set(product, cur);
      return false;
    }
    cur.used++;
    this.quota.set(product, cur);
    return true;
  }

  private warnHttp(what: string, e: any) {
    const status = e?.response?.status;
    const hint =
      status === 403
        ? ' — kalit shu mahsulotga ulanganini, uning cheklovlarini (IP/Referer) va kunlik limitini tekshiring'
        : status === 429
          ? ' — kunlik yoki soniyalik limit'
          : '';
    this.logger.warn(
      `${what} ishlamadi${status ? ` (HTTP ${status}${hint})` : ''}: ${this.errText(e)}`,
    );
  }

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
    const norm = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    // Nom o'xshashligi: biri ikkinchisini o'z ichiga oladi ("1-maktab" ~
    // "1-maktab (Andijon)"). Qo'shni ikki bino faqat masofa bilan birlashmasin.
    const similarName = (a: PlaceResult, b: PlaceResult) => {
      const x = norm(a.name);
      const y = norm(b.name);
      return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
    };
    const distOf = (r: PlaceResult) =>
      r.lat != null && r.lng != null
        ? haversineMeters(near.lat, near.lng, r.lat, r.lng)
        : r.distance;
    for (const it of items) {
      const hasCoords = it.lat != null && it.lng != null;
      const dup = out.find((o) => {
        if (!similarName(o, it)) return false;
        if (hasCoords && o.lat != null && o.lng != null)
          return haversineMeters(o.lat, o.lng, it.lat!, it.lng!) < DEDUPE_M;
        // Koordinatasiz (Geosaggest) natija: muassasagacha masofa deyarli bir xil
        const da = distOf(o);
        const db = distOf(it);
        return da != null && db != null
          ? Math.abs(da - db) < 150
          : norm(o.address ?? '') === norm(it.address ?? '');
      });
      if (dup) continue; // birinchi (ishonchliroq) manba qoladi
      out.push({
        ...it,
        distance: hasCoords
          ? Math.round(haversineMeters(near.lat, near.lng, it.lat!, it.lng!))
          : it.distance,
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

  private remember(key: string, results: PlaceResult[], ttl: number) {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), ttl, results });
  }

  private checkUserLimit(userId: string, limit = USER_LIMIT_PER_MIN) {
    const now = Date.now();
    const hits = (this.userHits.get(userId) ?? []).filter(
      (t) => now - t < 60_000,
    );
    if (hits.length >= limit) {
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
