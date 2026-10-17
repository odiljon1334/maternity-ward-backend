import { DateUtil } from './date.util';

type ShiftStart = { startTime: string; graceMinutes?: number | null };

/**
 * Xodim qachon kelishi kerak edi.
 *
 * Odatda smena boshlanishi. Grafik smena boshlangandan keyin berilgan
 * bo'lsa (bo'sh smena birjasi), `expectedStartAt` — o'sha vaqt.
 * Smena shabloni bo'lmasa — eski qoida: kun boshidan 08:00.
 */
export function shiftStartAt(
  workDate: Date,
  shift?: ShiftStart | null,
  expectedStartAt?: Date | null,
): Date {
  if (expectedStartAt) return expectedStartAt;
  return shift
    ? DateUtil.buildDateTime(workDate, shift.startTime)
    : new Date(workDate.getTime() + 8 * 3600 * 1000);
}

/**
 * Xodim qachondan boshlab "Kelmadi" hisoblanadi.
 *
 * Kutilgan kelish vaqti + kechikishga ruxsat (graceMinutes). Shu vaqtgacha
 * check-in bo'lmasa — u hali "Rejada": masalan soat 16:00 da 20:00 dagi
 * kechki smena xodimi kelmagan emas, uning smenasi hali boshlanmagan.
 */
export function checkInDeadline(
  workDate: Date,
  shift?: ShiftStart | null,
  expectedStartAt?: Date | null,
): Date {
  const start = shiftStartAt(workDate, shift, expectedStartAt);
  return new Date(start.getTime() + (shift?.graceMinutes ?? 0) * 60_000);
}

/** Smena hali boshlanmagan (yoki kechikishga ruxsat vaqti tugamagan) */
export function isAwaitingCheckIn(
  workDate: Date,
  shift: ShiftStart | null | undefined,
  now: Date = new Date(),
  expectedStartAt?: Date | null,
): boolean {
  return (
    now.getTime() < checkInDeadline(workDate, shift, expectedStartAt).getTime()
  );
}
