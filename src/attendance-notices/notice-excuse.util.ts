import type { PrismaService } from '../prisma/prisma.service';

/**
 * Tasdiqlangan "Kechikaman" xabari bo'lsa — o'sha kungi KELISHDAGI
 * kechikishni uzrli deb belgilaydi (tushlikdan kechikish uzrga kirmaydi).
 *
 * Ikki joydan chaqiriladi: direktor tasdiqlaganda (xodim allaqachon kelgan
 * bo'lsa) va xodim kelganda (xabar oldinroq tasdiqlangan bo'lsa).
 * Idempotent — qayta chaqirish natijani o'zgartirmaydi.
 */
export async function applyNoticeExcuse(
  prisma: Pick<PrismaService, 'attendanceNotice' | 'attendanceRecord'>,
  employeeId: string,
  workDate: Date,
): Promise<number | null> {
  const notice = await prisma.attendanceNotice.findFirst({
    where: { employeeId, workDate, status: 'APPROVED', type: 'LATE_ARRIVAL' },
    select: { id: true },
  });
  if (!notice) return null;

  const rec = await prisma.attendanceRecord.findFirst({
    where: { employeeId, workDate },
    select: {
      id: true,
      checkIn: true,
      lateMinutes: true,
      lunchLateMin: true,
      excusedLateMin: true,
    },
  });
  if (!rec?.checkIn) return null;

  const arrivalLate = Math.max(
    0,
    (rec.lateMinutes ?? 0) - (rec.lunchLateMin ?? 0),
  );
  if (rec.excusedLateMin !== arrivalLate) {
    await prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: { excusedLateMin: arrivalLate },
    });
  }
  return arrivalLate;
}

/** Hisobot va oylik uchun: uzrsiz kechikish */
export const unexcusedLate = (r: {
  lateMinutes: number;
  excusedLateMin?: number | null;
}) => Math.max(0, (r.lateMinutes ?? 0) - (r.excusedLateMin ?? 0));
