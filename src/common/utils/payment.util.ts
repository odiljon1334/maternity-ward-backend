import { PrismaService } from '../../prisma/prisma.service';

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

/**
 * Kasalxona bloklangan yoki yo'qligini tekshirish.
 *
 * Blok 2 holda:
 * 1. Admin manually `isBlocked = true` qilgan
 * 2. Avtomatik: o'tgan oyda OVERDUE to'lov bor
 *
 * PENDING (joriy oy hali to'lanmagan) — BLOK YO'Q
 */
export async function isHospitalBlocked(
  prisma: PrismaService,
  hospitalId: string | null | undefined,
): Promise<boolean> {
  if (!hospitalId) return false;

  // 1. Manual blok
  const hospital = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: { isBlocked: true },
  });
  if (hospital?.isBlocked) return true;

  // 2. Avtomatik: o'tgan oyda OVERDUE to'lov
  const prevDate = new Date();
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prevPeriod = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const overduePayment = await prisma.payment.findFirst({
    where: { hospitalId, period: prevPeriod, status: 'OVERDUE' },
  });

  return !!overduePayment;
}
