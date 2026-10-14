import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Admin muassasani bloklaganda (Hospital.isBlocked) shu muassasaga tegishli
 * HAMMA hisob — direktor, admin, bo'lim boshlig'i, xodim — tizimga kira
 * olmaydi, mavjud sessiyalar keyingi so'rovdayoq tugaydi. Terminal
 * davomati esa yozilaveradi, Telegram xabarlari yuborilmaydi.
 * Blok olib tashlansa hammasi darhol tiklanadi.
 */
/** Bloklangan muassasa bog'lanadigan aloqa (ENV bilan almashtirish mumkin). */
export const HOSPITAL_BLOCKED_CONTACT = {
  telegram:
    process.env.SUPPORT_TELEGRAM_USERNAME?.trim().replace(/^@/, '') ||
    'staffpluse_support',
  phone: process.env.BILLING_CONTACT_PHONE?.trim() || '+998 95 577 54 54',
};

export const HOSPITAL_BLOCKED_CODE = 'HOSPITAL_BLOCKED';

export const HOSPITAL_BLOCKED_LOGIN_MESSAGE = `Muassasa bloklangan, tizimga kirish yopilgan. Telegram: @${HOSPITAL_BLOCKED_CONTACT.telegram} yoki tel: ${HOSPITAL_BLOCKED_CONTACT.phone} orqali bog'laning.`;

/**
 * Login va sessiya rad etilganda qaytariladigan xato. `code` va `contact`
 * orqali web login sahifasi modal oyna ochadi; mobil ilova `message`ni
 * o'zicha ko'rsatadi.
 */
export function hospitalBlockedException() {
  return new UnauthorizedException({
    statusCode: 401,
    code: HOSPITAL_BLOCKED_CODE,
    message: HOSPITAL_BLOCKED_LOGIN_MESSAGE,
    contact: HOSPITAL_BLOCKED_CONTACT,
  });
}

/**
 * Platforma darajasidagi rollar muassasa blokidan ta'sirlanmaydi: SUPER_ADMIN
 * blokni ochishi kerak, MINISTRY faqat umumiy statistikani kuzatadi.
 */
const PLATFORM_ROLES: ReadonlySet<string> = new Set([
  UserRole.SUPER_ADMIN,
  UserRole.MINISTRY,
]);

/**
 * Foydalanuvchi muassasa bloki sababli tizimga kira olmaydimi.
 *
 * - ASSISTANT_ADMIN bir nechta muassasaga biriktirilishi mumkin: biriktirilgan
 *   muassasalarining HAMMASI bloklangan bo'lsa kira olmaydi; bittasi ochiq
 *   bo'lsa kiradi, lekin bloklangan muassasa unga ko'rinmaydi
 *   (TenantScopeGuard va boshqa joylarda `hospital.isBlocked: false`).
 * - Qolgan rollar — o'z muassasasi bloklangan bo'lsa kira olmaydi.
 *
 * `hospitalBlocked` — chaqiruvchi foydalanuvchi bilan birga o'qigan qiymat
 * (qo'shimcha so'rovsiz). Berilmasa bazadan o'qiladi.
 */
export async function isUserLockedByHospitalBlock(
  prisma: PrismaService,
  user: { id: string; role: string; hospitalId?: string | null },
  hospitalBlocked?: boolean | null,
): Promise<boolean> {
  if (PLATFORM_ROLES.has(user.role)) return false;

  if (user.role === UserRole.ASSISTANT_ADMIN) {
    const [assigned, open] = await Promise.all([
      prisma.hospitalAssistant.count({ where: { userId: user.id } }),
      prisma.hospitalAssistant.count({
        where: { userId: user.id, hospital: { isBlocked: false } },
      }),
    ]);
    return assigned > 0 && open === 0;
  }

  if (!user.hospitalId) return false;
  if (typeof hospitalBlocked === 'boolean') return hospitalBlocked;
  const hospital = await prisma.hospital.findUnique({
    where: { id: user.hospitalId },
    select: { isBlocked: true },
  });
  return !!hospital?.isBlocked;
}

/** Telegram obunalari so'rovlarida: bloklangan muassasa obunalarini chiqarib tashlaydi. */
export const NOT_BLOCKED_HOSPITAL_SUBSCRIPTION = {
  NOT: { hospital: { isBlocked: true } },
} as const;
