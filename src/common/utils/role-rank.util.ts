import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Rollar ierarxiyasi. Foydalanuvchi faqat O'ZIDAN PAST darajadagi hisobni
 * boshqara oladi (parol/login, holat, ishdan bo'shatish, o'chirish).
 * Ilgari ADMIN direktorning parolini almashtirib, uni tizimdan chiqarib
 * yubora olardi.
 */
export const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.SUPER_ADMIN]: 100,
  [UserRole.MINISTRY]: 90,
  [UserRole.ASSISTANT_ADMIN]: 80,
  [UserRole.DIRECTOR]: 60,
  [UserRole.ADMIN]: 50,
  [UserRole.DEPARTMENT_HEAD]: 30,
  [UserRole.EMPLOYEE]: 10,
};

export function canManageRole(
  actorRole: UserRole | string | null | undefined,
  targetRole: UserRole | string | null | undefined,
): boolean {
  if (!targetRole) return true; // hisob bog'lanmagan xodim
  const a = ROLE_RANK[actorRole as UserRole] ?? 0;
  const t = ROLE_RANK[targetRole as UserRole] ?? 100;
  // SUPER_ADMIN hammani (boshqa SUPER_ADMIN'dan tashqari) boshqaradi
  return a > t;
}

export function assertCanManageRole(
  actorRole: UserRole | string | null | undefined,
  targetRole: UserRole | string | null | undefined,
  action = "bu hisobni o'zgartirish",
): void {
  if (!canManageRole(actorRole, targetRole)) {
    throw new ForbiddenException(
      `Sizda ${action} huquqi yo'q — bu foydalanuvchi darajasi sizdan past emas`,
    );
  }
}
