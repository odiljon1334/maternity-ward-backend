import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Post grafigi uchun tez mahalliy vaqt hisobi.
 *
 * Nega kerak: `dayjs(...).tz(TZ)` har chaqiruvda Intl orqali vaqt zonasini
 * qayta hisoblaydi. 40 xodim × 31 kunlik grafikda bu minglab chaqiruv
 * bo'lib, profil bo'yicha so'rov vaqtining ~70% ini egallagan.
 *
 * Asia/Tashkent 1992-yildan beri doimiy UTC+5 (yozgi vaqt yo'q). Shuning
 * uchun zona offseti modul yuklanganda bir marta tekshiriladi: agar u
 * FAST_RANGE oralig'ida o'zgarmas bo'lsa, sana oddiy arifmetika bilan
 * hisoblanadi. Boshqa zona (yoki oraliqdan tashqari sana) bo'lsa, eski
 * dayjs yo'li ishlatiladi — natija har doim bir xil.
 */
export const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FAST_RANGE_START_MS = Date.UTC(2000, 0, 1);
const FAST_RANGE_END_MS = Date.UTC(2100, 0, 1);

function detectFixedOffsetMs(zone: string): number | null {
  try {
    let offset: number | null = null;
    // Har yili yanvar va iyul — yozgi vaqt bo'lsa, shu ikkisida farq chiqadi.
    for (let year = 2000; year < 2100; year += 1) {
      for (const month of [0, 3, 6, 9]) {
        const value = dayjs(Date.UTC(year, month, 15))
          .tz(zone)
          .utcOffset();
        if (offset === null) offset = value;
        if (value !== offset) return null;
      }
    }
    return offset === null ? null : offset * MINUTE_MS;
  } catch {
    return null;
  }
}

const FIXED_OFFSET_MS = detectFixedOffsetMs(TZ);

/** Testlar uchun: tezkor yo'l ishlayaptimi. */
export function isFastTimezonePath(): boolean {
  return FIXED_OFFSET_MS !== null;
}

/**
 * `dayjs(value)` bilan bir xil o'qiydi: Date — o'zi, satr — dayjs qoidasi
 * bo'yicha (ofsetsiz satr server vaqti deb olinadi), shuning uchun eski
 * kod bilan farq bo'lmaydi.
 */
export function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return dayjs(value).valueOf();
}

function canUseFast(ms: number): boolean {
  return (
    FIXED_OFFSET_MS !== null &&
    Number.isFinite(ms) &&
    ms >= FAST_RANGE_START_MS &&
    ms < FAST_RANGE_END_MS
  );
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function isoFromLocalMs(localMs: number): string {
  const date = new Date(localMs);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export interface LocalDateParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  /** 0 — Yakshanba */
  weekday: number;
  /** YYYY-MM-DD */
  iso: string;
}

/** Berilgan vaqt muassasa zonasida qaysi kunga to'g'ri keladi. */
export function localDateParts(value: Date | string | number): LocalDateParts {
  const ms = toEpochMs(value);
  if (canUseFast(ms)) {
    const local = new Date(ms + (FIXED_OFFSET_MS as number));
    return {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      weekday: local.getUTCDay(),
      iso: isoFromLocalMs(local.getTime()),
    };
  }
  const local = dayjs(ms).tz(TZ);
  return {
    year: local.year(),
    month: local.month() + 1,
    day: local.date(),
    weekday: local.day(),
    iso: local.format('YYYY-MM-DD'),
  };
}

/** Oy boshi/oxiri (zona yarim tuni) epoch ms da. */
export function localMonthBoundsMs(
  year: number,
  month: number,
): { startMs: number; endMs: number } {
  const probe = Date.UTC(year, month - 1, 1);
  if (canUseFast(probe)) {
    const offset = FIXED_OFFSET_MS as number;
    return {
      startMs: Date.UTC(year, month - 1, 1) - offset,
      endMs: Date.UTC(year, month, 1) - offset,
    };
  }
  const start = dayjs.tz(`${year}-${pad2(month)}-01`, TZ);
  return { startMs: start.valueOf(), endMs: start.add(1, 'month').valueOf() };
}

/**
 * Oraliqni (smenani) zona kunlari bo'yicha daqiqalarga ajratadi va berilgan
 * oy bilan qirqadi. 20:00–08:00 → { D: 240, D+1: 480 }.
 *
 * Qaytaradi `null` — oraliq noto'g'ri (tugash boshlanishdan oldin).
 */
export function splitIntervalMinutesByLocalDate(
  startsAt: Date | string,
  endsAt: Date | string,
  year: number,
  month: number,
): Record<string, number> | null {
  const startMs = toEpochMs(startsAt);
  const endMs = toEpochMs(endsAt);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }

  if (!canUseFast(startMs) || !canUseFast(endMs)) {
    return splitWithDayjs(startMs, endMs, year, month);
  }

  const offset = FIXED_OFFSET_MS as number;
  const { startMs: monthStartMs, endMs: monthEndMs } = localMonthBoundsMs(
    year,
    month,
  );
  let cursor = Math.max(startMs, monthStartMs);
  const clippedEnd = Math.min(endMs, monthEndMs);
  const result: Record<string, number> = {};

  while (cursor < clippedEnd) {
    const local = cursor + offset;
    const nextDay = Math.floor(local / DAY_MS) * DAY_MS + DAY_MS - offset;
    const segmentEnd = Math.min(nextDay, clippedEnd);
    const key = isoFromLocalMs(local);
    // dayjs.diff(..., 'minute') kabi nol tomon kesiladi.
    result[key] =
      (result[key] ?? 0) + Math.trunc((segmentEnd - cursor) / MINUTE_MS);
    cursor = segmentEnd;
  }

  return result;
}

/** Eski (sekin, lekin har qanday zonada to'g'ri) yo'l. */
function splitWithDayjs(
  startMs: number,
  endMs: number,
  year: number,
  month: number,
): Record<string, number> {
  const start = dayjs(startMs).tz(TZ);
  const end = dayjs(endMs).tz(TZ);
  const monthStart = dayjs.tz(`${year}-${pad2(month)}-01`, TZ);
  const monthEnd = monthStart.add(1, 'month');
  let cursor = start.isBefore(monthStart) ? monthStart : start;
  const clippedEnd = end.isAfter(monthEnd) ? monthEnd : end;
  const result: Record<string, number> = {};

  while (cursor.isBefore(clippedEnd)) {
    const nextDay = cursor.add(1, 'day').startOf('day');
    const segmentEnd = nextDay.isBefore(clippedEnd) ? nextDay : clippedEnd;
    const key = cursor.format('YYYY-MM-DD');
    result[key] = (result[key] ?? 0) + segmentEnd.diff(cursor, 'minute');
    cursor = segmentEnd;
  }

  return result;
}

/** Test uchun eski algoritmni ochiq qoldiramiz (tezkor yo'l bilan solishtirish). */
export function splitIntervalMinutesByLocalDateLegacy(
  startsAt: Date | string,
  endsAt: Date | string,
  year: number,
  month: number,
): Record<string, number> {
  return splitWithDayjs(toEpochMs(startsAt), toEpochMs(endsAt), year, month);
}
