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

/** O'zbekistonda kenglik ~37–46, uzunlik ~55–74: tartib almashgan bo'lsa to'g'rilaydi */
function orient(a: number, b: number): LatLng | null {
  if (!plausible(a, b) && !plausible(b, a)) return null;
  const looksSwapped = a >= 50 && a <= 80 && b >= 30 && b <= 50;
  return looksSwapped ? { lat: b, lng: a } : { lat: a, lng: b };
}

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

/**
 * Matndan koordinata: oddiy juftlik yoki xarita havolasi.
 * Yandex havolalarida tartib "uzunlik,kenglik" (ll=72.34,40.78; pt=...;
 * whatshere[point]=...), Google'da "kenglik,uzunlik" (@40.78,72.34 yoki !3d..!4d..).
 */
export function parseCoordinates(input: string): LatLng | null {
  if (!input) return null;
  let text = input.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    /* noto'g'ri kodlangan havola — o'zicha qoladi */
  }
  const isYandex = /yandex\.|ya\.ru/i.test(text);
  const pair = '(-?\\d{1,3}(?:\\.\\d+)?)\\s*,\\s*(-?\\d{1,3}(?:\\.\\d+)?)';

  if (isYandex) {
    const m =
      text.match(new RegExp(`whatshere\\[point\\]=${pair}`)) ||
      text.match(new RegExp(`[?&]pt=${pair}`)) ||
      text.match(new RegExp(`[?&]ll=${pair}`));
    if (m) {
      const lng = num(m[1]);
      const lat = num(m[2]);
      return plausible(lat, lng) ? { lat, lng } : null;
    }
  }

  const g =
    text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
    text.match(new RegExp(`@${pair}`)) ||
    text.match(new RegExp(`[?&](?:q|query|ll|daddr|destination)=${pair}`));
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
  const numMatch = q.match(/(?:№\s*)?(\d{1,3})\s*[-–]?\s*(?:son(?:li)?\s*)?/);
  const kind = KINDS.find((k) => k.re.test(q));
  if (numMatch && kind) {
    const n = numMatch[1];
    // Shahar/tuman qismi: raqam va tur so'zidan tashqari hamma narsa
    const place = q
      .replace(kind.re, ' ')
      .replace(/(?:№\s*)?\d{1,3}\s*[-–]?\s*(?:son(?:li)?)?/, ' ')
      .replace(/\b(shahar|shahri|tumani|tuman|город|район)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const suffix = place ? ` ${place}` : '';
    out.push(`${n}-son ${kind.uz}${suffix}`, `${kind.ru} № ${n}${suffix}`);
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))].slice(0, max);
}
