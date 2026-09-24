/**
 * Obuna hisob-kitobining yagona manbasi (FAZA 6 · 2-paket).
 *
 * Asosiy tushuncha — QOPLAMA (coverage): har bir PAID to'lov `period` oyidan
 * boshlab ketma-ket `months` ta kalendar oyini qoplaydi.
 *   - Oylik to'lov (months = 1): shu oyga qo'shiladi; bir oyda bir nechta
 *     qisman to'lov bo'lishi mumkin — yig'indi kutilgan summa bilan solishtiriladi.
 *   - Ko'p oylik (yillik) to'lov (months > 1): qoplagan har bir oy TO'LIQ
 *     to'langan hisoblanadi (yillik tarif chegirmali — summasini oylarga
 *     bo'lib, oylik tarif bilan solishtirish noto'g'ri "qarz" chiqarardi).
 *   - Daromad (MRR): to'lov summasi qoplagan oylarga teng taqsimlanadi.
 *   - Bot invoysi orqali to'langan oy (invoiceId bor — summa serverda
 *     hisoblangan va tekshirilgan) TO'LIQ qoplangan hisoblanadi.
 *   - Qo'lda kiritilgan oylik to'lov o'sha paytdagi xodimlar soni
 *     (employeeCount) bo'yicha kutilgan summa bilan solishtiriladi: keyin
 *     xodim qo'shilsa, to'langan o'tgan oylar "qarz"ga aylanib qolmaydi.
 *
 * Barcha oylar Asia/Tashkent vaqti bo'yicha hisoblanadi — server UTC'da
 * bo'lsa ham oy chegarasi (1-sana 00:00) to'g'ri keladi.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  getMonthlyExpectedAmount,
  getStaffPricing,
} from '../common/utils/pricing.util';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BILLING_TZ = process.env.TIMEZONE || 'Asia/Tashkent';
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type PeriodStatus = 'PAID' | 'PENDING' | 'OVERDUE';

export interface CoveragePayment {
  period: string | null;
  months?: number | null;
  amount: number | string | { toString(): string };
  paidAt?: Date | string | null;
  /** To'lov paytidagi faol xodimlar soni (snapshot) */
  employeeCount?: number | null;
  /** Bot invoysi orqali — summa serverda hisoblangan, to'liq qoplaydi */
  invoiceId?: string | null;
}

export interface PeriodCoverage {
  /** Shu oyga tushgan oylik (months=1) to'lovlar yig'indisi */
  paidAmount: number;
  /** Ko'p oylik (yillik) to'lov bilan to'liq qoplangan */
  prepaid: boolean;
  /** Bot invoysi bo'yicha to'langan (to'liq qoplangan) */
  settled: boolean;
  /**
   * To'lov paytidagi xodimlar soni bo'yicha kutilgan summa (bir nechta
   * to'lov bo'lsa — eng kattasi). null — snapshot yo'q (eski yozuvlar).
   */
  snapshotExpected: number | null;
  /** Tan olingan daromad: har bir to'lovdan shu oyga tushgan ulush */
  recognized: number;
}

export function isValidPeriod(p: unknown): p is string {
  return typeof p === 'string' && PERIOD_RE.test(p);
}

/** Hozirgi (yoki berilgan sana) oy, Toshkent vaqti bo'yicha: "YYYY-MM" */
export function periodOf(date: Date | string | number = new Date()): string {
  return dayjs(date).tz(BILLING_TZ).format('YYYY-MM');
}

/** "2026-09" + 3 → "2026-12"; manfiy son orqaga suradi. Sana 31 bo'lsa ham xato bermaydi. */
export function addPeriods(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** a < b → manfiy, teng → 0 (satr tartibi "YYYY-MM" uchun to'g'ri) */
export function comparePeriods(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oyning oxirgi lahzasi (Toshkent vaqti bo'yicha) */
export function periodEnd(period: string): Date {
  return dayjs
    .tz(`${period}-01 00:00`, BILLING_TZ)
    .add(1, 'month')
    .subtract(1, 'millisecond')
    .toDate();
}

/** Oyning birinchi lahzasi (Toshkent vaqti bo'yicha) */
export function periodStart(period: string): Date {
  return dayjs.tz(`${period}-01 00:00`, BILLING_TZ).toDate();
}

/** [from..to] oraliqdagi barcha oylar (ikkala chekka ham kiradi) */
export function periodRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let p = from; comparePeriods(p, to) <= 0; p = addPeriods(p, 1))
    out.push(p);
  return out;
}

/** Oxirgi N oy (joriy oy ham kiradi), eskisidan yangisiga */
export function lastNPeriods(n: number, now: Date = new Date()): string[] {
  const cur = periodOf(now);
  return periodRange(addPeriods(cur, -(n - 1)), cur);
}

function toNumber(v: CoveragePayment['amount']): number {
  const n = Number(typeof v === 'object' ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
}

/** To'lov qaysi oydan boshlanadi (eski yozuvlarda period bo'lmasa — to'langan oyi) */
function startPeriodOf(p: CoveragePayment): string | null {
  if (isValidPeriod(p.period)) return p.period;
  return p.paidAt ? periodOf(p.paidAt) : null;
}

/** To'lovlar ro'yxatidan oy → qoplama xaritasi */
export function buildCoverage(
  payments: CoveragePayment[],
): Map<string, PeriodCoverage> {
  const map = new Map<string, PeriodCoverage>();
  const get = (period: string) => {
    let c = map.get(period);
    if (!c) {
      c = {
        paidAmount: 0,
        prepaid: false,
        settled: false,
        snapshotExpected: null,
        recognized: 0,
      };
      map.set(period, c);
    }
    return c;
  };
  for (const p of payments) {
    const start = startPeriodOf(p);
    if (!start) continue;
    const months = Math.max(1, Math.floor(Number(p.months ?? 1)) || 1);
    const amount = toNumber(p.amount);
    if (months === 1) {
      const c = get(start);
      c.paidAmount += amount;
      c.recognized += amount;
      if (p.invoiceId) c.settled = true;
      if (p.employeeCount != null && p.employeeCount > 0) {
        // Kelishilgan narx (501+) — tizimda aniq narx yo'q: operator
        // kiritgan to'lov oyni qoplaydi
        const snap = getStaffPricing(p.employeeCount).negotiated
          ? 0
          : getMonthlyExpectedAmount(p.employeeCount);
        c.snapshotExpected =
          c.snapshotExpected == null
            ? snap
            : Math.max(c.snapshotExpected, snap);
      }
      continue;
    }
    const share = amount / months;
    for (let i = 0; i < months; i++) {
      const c = get(addPeriods(start, i));
      c.prepaid = true;
      c.recognized += share;
    }
  }
  return map;
}

/**
 * Oy to'liq qoplanganmi. Oylik to'lov joriy kutilgan summa bilan, snapshot
 * bo'lsa — to'lov paytidagi summa bilan (qaysi biri kichik) solishtiriladi.
 */
export function isPeriodCovered(
  expectedAmount: number,
  c: PeriodCoverage | undefined,
): boolean {
  if (expectedAmount <= 0) return true;
  if (!c) return false;
  if (c.prepaid || c.settled) return true;
  const required =
    c.snapshotExpected != null
      ? Math.min(expectedAmount, c.snapshotExpected)
      : expectedAmount;
  return c.paidAmount > 0 && c.paidAmount >= required;
}

/** Bitta oyning holati */
export function periodStatus(
  period: string,
  expectedAmount: number,
  coverage: PeriodCoverage | undefined,
  now: Date = new Date(),
): PeriodStatus {
  if (isPeriodCovered(expectedAmount, coverage)) return 'PAID';
  return now.getTime() <= periodEnd(period).getTime() ? 'PENDING' : 'OVERDUE';
}

/** Oy uchun to'langan deb ko'rsatiladigan summa (yillik qoplamada — kutilgan summa) */
export function periodPaidAmount(
  expectedAmount: number,
  coverage: PeriodCoverage | undefined,
): number {
  if (!coverage) return 0;
  if (coverage.prepaid) return Math.max(expectedAmount, coverage.paidAmount);
  // Bot invoysi yoki snapshot bo'yicha to'liq qoplangan oy — to'liq ko'rinadi
  if (isPeriodCovered(expectedAmount, coverage))
    return Math.max(expectedAmount, coverage.paidAmount);
  return coverage.paidAmount;
}

/**
 * Oxirgi to'liq to'langan oy (null — umuman to'lanmagan). Faqat ketma-ket
 * qoplamaga qaramaydi: eng oxirgi to'langan oyni qaytaradi.
 */
export function lastPaidPeriod(
  coverage: Map<string, PeriodCoverage>,
  expectedAmount: number,
): string | null {
  let last: string | null = null;
  for (const [period, c] of coverage) {
    if (
      isPeriodCovered(expectedAmount, c) &&
      (!last || comparePeriods(period, last) > 0)
    )
      last = period;
  }
  return last;
}

/** Avto-blok va bot shu oynaga qaraydi: oxirgi 3 ta tugagan oy */
export const BILLING_LOOKBACK_MONTHS = 3;

function envDays(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Sinov davri tugaydigan lahza (BILLING_TRIAL_DAYS, standart 14 kun) */
export function trialEndOf(createdAt: Date): Date {
  return new Date(
    createdAt.getTime() + envDays('BILLING_TRIAL_DAYS', 14) * 86_400_000,
  );
}

/** Birinchi to'lanadigan oy — sinov davri tugagan oy */
export function firstBillablePeriod(createdAt: Date): string {
  return periodOf(trialEndOf(createdAt));
}

/**
 * Yangi to'lov qaysi oydan boshlanadi (bot va operator uchun yagona qoida).
 *
 *  - Oylik: oynadagi (oxirgi 3 oy, sinov davridan keyin) ENG ESKI
 *    to'lanmagan oy — avto-blok qaysi oylarga qarasa, bot aynan o'shalarni
 *    to'lashni taklif qiladi (ilgari blok 3 oyga, bot 2 oyga qarardi va
 *    muassasa botda to'lab blokdan chiqa olmasdi). Hammasi to'langan bo'lsa —
 *    birinchi qoplanmagan kelgusi oy (oldindan to'lash).
 *  - Yillik: shu oydan boshlab 12 oyning HECH BIRI qoplanmagan birinchi
 *    boshlanish — yillik to'lov to'langan oylar ustiga tushib, pul bekor
 *    ketmasin (orada bo'shliq bo'lsa, u oylik to'lanadi).
 */
export function billingStartPeriods(
  isCovered: (period: string) => boolean,
  opts: { now?: Date; firstBillable?: string | null } = {},
): { monthly: string; annual: string } {
  const current = periodOf(opts.now ?? new Date());
  let floor = addPeriods(current, -BILLING_LOOKBACK_MONTHS);
  if (opts.firstBillable && comparePeriods(opts.firstBillable, floor) > 0) {
    floor = opts.firstBillable;
  }
  const LIMIT = 48;
  let monthly = floor;
  for (let i = 0; i < LIMIT && isCovered(monthly); i++)
    monthly = addPeriods(monthly, 1);

  let annual = monthly;
  for (let i = 0; i < LIMIT; i++, annual = addPeriods(annual, 1)) {
    let free = true;
    for (let k = 0; k < 12 && free; k++) {
      if (isCovered(addPeriods(annual, k))) free = false;
    }
    if (free) break;
  }
  return { monthly, annual };
}

const UZ_MONTHS = [
  'Yanvar',
  'Fevral',
  'Mart',
  'Aprel',
  'May',
  'Iyun',
  'Iyul',
  'Avgust',
  'Sentabr',
  'Oktabr',
  'Noyabr',
  'Dekabr',
];

/** "2026-09" → "Sentabr 2026" */
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${UZ_MONTHS[m - 1]} ${y}`;
}

/** Qoplama oralig'ining matni: "Sentabr 2026" yoki "Sentabr 2026 – Avgust 2027" */
export function coverageLabel(start: string, months: number): string {
  if (months <= 1) return periodLabel(start);
  return `${periodLabel(start)} – ${periodLabel(addPeriods(start, months - 1))}`;
}

/** To'lov turiga ko'ra qoplanadigan oylar soni */
export function monthsForType(type: string | null | undefined): number {
  return type === 'ANNUAL' ? 12 : 1;
}
