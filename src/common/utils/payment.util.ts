import { PrismaService } from '../../prisma/prisma.service';
import { getMonthlyExpectedAmount } from './pricing.util';
import {
  addPeriods,
  buildCoverage,
  periodEnd,
  periodOf,
  periodStart,
  periodStatus,
} from '../../payments/billing.util';

/**
 * Daqiqalarni "X soat Y daqiqa" formatga o'tkazish
 */
export function formatMinutes(min: number): string {
  if (min <= 0) return '0 daqiqa';
  if (min < 60) return `${min} daqiqa`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h} soat ${m} daqiqa` : `${h} soat`;
}

/** Avto-blok natijasini qisqa muddat keshlash (har check-in'da bazaga 3 so'rov bormasin) */
const BLOCK_CACHE_TTL_MS = 60_000;
const blockCache = new Map<string, { value: boolean; at: number }>();

/** Testlar va to'lov qabul qilingandan keyin keshni tozalash uchun */
export function clearHospitalBlockCache(hospitalId?: string) {
  if (hospitalId) blockCache.delete(hospitalId);
  else blockCache.clear();
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Kasalxona bloklangan yoki yo'qligini tekshirish.
 *
 * 1. Qo'lda blok — admin `isBlocked = true` qilgan (har doim ishlaydi).
 * 2. Avtomatik blok — FAQAT `BILLING_AUTO_BLOCK=true` bo'lsa:
 *    o'tgan oylardan biri (oxirgi 3 oy ichida) to'lanmagan va o'sha oy
 *    tugaganiga `BILLING_GRACE_DAYS` (standart 10) kundan ko'p bo'lgan.
 *    Yangi ulangan muassasa birinchi `BILLING_TRIAL_DAYS` (standart 14) kun
 *    ichida tugagan oylar uchun bloklanmaydi.
 *
 * Ilgari avto-blok `status: 'OVERDUE'` qatorini qidirardi — bunday qatorni
 * hech kim yozmasdi, ya'ni avto-blok hech qachon ishlamasdi; oyning 31-sanasida
 * esa `setMonth(-1)` o'tgan oy o'rniga joriy oyni qaytarardi.
 */
export async function isHospitalBlocked(
  prisma: PrismaService,
  hospitalId: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!hospitalId) return false;

  const hospital = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: { isBlocked: true, createdAt: true },
  });
  if (!hospital) return false;
  if (hospital.isBlocked) return true;
  if (process.env.BILLING_AUTO_BLOCK !== 'true') return false;

  const cached = blockCache.get(hospitalId);
  if (cached && now.getTime() - cached.at < BLOCK_CACHE_TTL_MS)
    return cached.value;

  const value = await computeAutoBlock(
    prisma,
    hospitalId,
    hospital.createdAt,
    now,
  );
  blockCache.set(hospitalId, { value, at: now.getTime() });
  return value;
}

async function computeAutoBlock(
  prisma: PrismaService,
  hospitalId: string,
  createdAt: Date,
  now: Date,
): Promise<boolean> {
  const graceMs = envInt('BILLING_GRACE_DAYS', 10) * 86_400_000;
  const trialEnd =
    createdAt.getTime() + envInt('BILLING_TRIAL_DAYS', 14) * 86_400_000;

  const employeeCount = await prisma.employee.count({
    where: { hospitalId, firedAt: null },
  });
  const expected = getMonthlyExpectedAmount(employeeCount);
  if (expected <= 0) return false;

  const current = periodOf(now);
  const since = addPeriods(current, -15);
  const payments = await prisma.payment.findMany({
    where: {
      hospitalId,
      status: 'PAID',
      OR: [
        { period: { gte: since } },
        { period: null, paidAt: { gte: periodStart(since) } },
      ],
    },
    select: { period: true, months: true, amount: true, paidAt: true },
  });
  const coverage = buildCoverage(payments);

  return [-3, -2, -1]
    .map((i) => addPeriods(current, i))
    .some((p) => {
      const end = periodEnd(p).getTime();
      if (end <= trialEnd) return false; // sinov davrida tugagan oy
      if (now.getTime() - end < graceMs) return false; // imtiyozli muddat
      return periodStatus(p, expected, coverage.get(p), now) === 'OVERDUE';
    });
}
