import { DateUtil } from './date.util';

/**
 * Xodim qachondan boshlab "Kelmadi" hisoblanadi.
 *
 * Smena boshlanishi + kechikishga ruxsat (graceMinutes). Shu vaqtgacha
 * check-in bo'lmasa — u hali "Rejada": masalan soat 16:00 da 20:00 dagi
 * kechki smena xodimi kelmagan emas, uning smenasi hali boshlanmagan.
 * Smena shabloni bo'lmasa — eski qoida: kun boshidan 08:00.
 */
export function checkInDeadline(
  workDate: Date,
  shift?: { startTime: string; graceMinutes?: number | null } | null,
): Date {
  const start = shift
    ? DateUtil.buildDateTime(workDate, shift.startTime)
    : new Date(workDate.getTime() + 8 * 3600 * 1000);
  return new Date(start.getTime() + (shift?.graceMinutes ?? 0) * 60_000);
}

/** Smena hali boshlanmagan (yoki kechikishga ruxsat vaqti tugamagan) */
export function isAwaitingCheckIn(
  workDate: Date,
  shift: { startTime: string; graceMinutes?: number | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  return now.getTime() < checkInDeadline(workDate, shift).getTime();
}
