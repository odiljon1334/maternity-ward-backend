/**
 * Ish joyi manzilini qidirish uchun sof (tarmoqsiz) yordamchilar.
 *
 *  - parseCoordinates: "40.7821, 72.3442" yoki Yandex/Google xarita havolasidan
 *    koordinata ajratadi — hech qanday tashqi xizmatsiz, eng ishonchli yo'l.
 *  - buildQueryVariants: "1-maktab Andijon" → OSM'dagi turli yozilishlar
 *    ("1-son maktab", "maktab № 1", "школа № 1" ...).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** O'zbekiston va qo'shni hududlar uchun oqilona chegara (xato tartibni aniqlash uchun) */
function plausible(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Tartib: odatda "kenglik, uzunlik". O'zbekistonda kenglik ~37–46, uzunlik
 * ~55–74 — "72.34, 40.78" ko'rinishida kelsa (Yandex nusxasi) almashtiriladi.
 * Faqat haqiqiy koordinata bo'la oladigan tartib qaytariladi.
 */
function orient(a: number, b: number): LatLng | null {
  const looksSwapped = a >= 50 && a <= 80 && b >= 30 && b <= 50;
  if (looksSwapped && plausible(b, a)) return { lat: b, lng: a };
  if (plausible(a, b)) return { lat: a, lng: b };
  if (plausible(b, a)) return { lat: b, lng: a };
  return null;
}

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

/** Havolani yumshoq dekodlash: buzilgan %-ketma-ketlik butun matnni buzmasin */
function softDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text
      .replace(/%2C/gi, ',')
      .replace(/%5B/gi, '[')
      .replace(/%5D/gi, ']')
      .replace(/%20/g, ' ')
      .replace(/%40/g, '@');
  }
}

/**
 * Matndan koordinata: oddiy juftlik yoki xarita havolasi.
 * Yandex havolalarida tartib "uzunlik,kenglik" (ll=72.34,40.78; pt=...;
 * whatshere[point]=...), Google'da "kenglik,uzunlik" (@40.78,72.34 yoki !3d..!4d..).
 */
export function parseCoordinates(input: string): LatLng | null {
  if (!input) return null;
  const text = softDecode(input.trim());
  const isYandex = /yandex\.|ya\.ru/i.test(text);
  const isUrl = /^https?:\/\/|maps\.|goo\.gl|yandex\./i.test(text);
  const pair = '(-?\\d{1,3}(?:\\.\\d+)?)\\s*,\\s*(-?\\d{1,3}(?:\\.\\d+)?)';
  // Havola ichidagi juftlik — faqat kasr sonlar ("info@1,2" koordinata emas)
  const decPair = '(-?\\d{1,3}\\.\\d+)\\s*,\\s*(-?\\d{1,3}\\.\\d+)';

  if (isYandex) {
    // Tartib muhim: poi/whatshere/pt — belgilangan nuqta; ll — faqat xarita markazi
    const m =
      text.match(new RegExp(`poi\\[point\\]=${pair}`)) ||
      text.match(new RegExp(`whatshere\\[point\\]=${pair}`)) ||
      text.match(new RegExp(`[?&]pt=${pair}`)) ||
      text.match(new RegExp(`[?&]ll=${pair}`));
    if (m) {
      const lng = num(m[1]);
      const lat = num(m[2]);
      return plausible(lat, lng) ? { lat, lng } : null;
    }
  }

  const g = isUrl
    ? text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
      text.match(new RegExp(`@${decPair}`)) ||
      text.match(new RegExp(`[?&](?:q|query|ll|daddr|destination)=${decPair}`))
    : null;
  if (g) {
    const lat = num(g[1]);
    const lng = num(g[2]);
    return plausible(lat, lng) ? { lat, lng } : null;
  }

  // Faqat raqamlardan iborat matn: "40.7821, 72.3442" / "40.7821 72.3442" / "40,7821; 72,3442"
  const plain = text.match(
    /^\s*(-?\d{1,3}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/,
  );
  if (plain) return orient(num(plain[1]), num(plain[2]));
  return null;
}

/** Tutuq belgilari va ortiqcha bo'shliqlarni bir xil ko'rinishga keltiradi */
export function normalizeQuery(q: string): string {
  return q
    .replace(/[ʻʼ‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const KINDS: Array<{ re: RegExp; uz: string; ru: string }> = [
  { re: /maktab(i)?|школ[аы]/i, uz: 'maktab', ru: 'школа' },
  {
    re: /bog'?cha(si)?|детск[а-яё]*\s*сад|dmtt/i,
    uz: "bog'cha",
    ru: 'детский сад',
  },
  {
    re: /poliklinika(si)?|поликлиник[а-яё]*/i,
    uz: 'poliklinika',
    ru: 'поликлиника',
  },
  { re: /kasalxona(si)?|больниц[а-яё]*/i, uz: 'kasalxona', ru: 'больница' },
  { re: /litsey(i)?|лице[йя]/i, uz: 'litsey', ru: 'лицей' },
  { re: /kollej(i)?|колледж[а-яё]*/i, uz: 'kollej', ru: 'колледж' },
];

/**
 * OSM'da raqamli muassasalar turlicha yozilgan: "1-maktab", "1-son maktab",
 * "1-sonli umumiy o'rta ta'lim maktabi", "Школа № 1". Birinchi variant — asl
 * so'rov; qolganlari faqat birinchisi hech narsa topmasa sinab ko'riladi.
 */
export function buildQueryVariants(raw: string, max = 3): string[] {
  const q = normalizeQuery(raw);
  const out = [q];
  const kind = KINDS.find((k) => k.re.test(q));
  // Tur so'zi bilan yonma-yon turgan raqam: "1-maktab", "1-sonli maktab",
  // "maktab № 1", "школа 1" — "5-uy 1-maktab" da 5 emas, 1 olinadi
  const numMatch = kind
    ? q.match(
        new RegExp(
          `(?:№\\s*)?(?<n>\\d{1,3})\\s*[-–]?\\s*(?:son(?:li)?\\s*)?(?=${kind.re.source})`,
          'i',
        ),
      ) ||
      q.match(
        new RegExp(
          `(?:${kind.re.source})\\s*(?:№|no\\.?)?\\s*(?<n>\\d{1,3})\\b`,
          'i',
        ),
      )
    : null;
  if (numMatch?.groups?.n && kind) {
    const n = numMatch.groups.n;
    // Shahar/tuman qismi: raqam va tur so'zidan tashqari hamma narsa
    const place = q
      .replace(numMatch[0], ' ')
      .replace(kind.re, ' ')
      .replace(/\b(shahar|shahri|tumani|tuman|город|район)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const suffix = place ? ` ${place}` : '';
    out.push(`${n}-son ${kind.uz}${suffix}`, `${kind.ru} № ${n}${suffix}`);
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))].slice(0, max);
}
