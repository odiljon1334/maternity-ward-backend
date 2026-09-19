import { UserRole } from '@prisma/client';

/**
 * Granular ruxsatlar katalogi (FAZA 5, 7-bosqich, 2026-09-19).
 *
 * MUHIM: bu mavjud @Roles/RolesGuard tizimini ALMASHTIRMAYDI — ustiga
 * qo'shimcha, ixtiyoriy cheklov qatlami. Har bir endpoint avvalgidek
 * @Roles bilan himoyalangan; @RequirePermission faqat SHU rol allaqachon
 * ruxsat berilgan doira ICHIDA, alohida foydalanuvchi uchun standartdan
 * chetga chiqishga (odatda cheklashga) imkon beradi.
 *
 * Yangi ruxsat qo'shish uchun: shu ro'yxatga qo'shing va
 * ROLE_DEFAULT_PERMISSIONS'da tegishli rollarga bugungi xatti-harakatga
 * mos qilib belgilang (standart holat hech kim uchun hech narsani
 * o'zgartirmasligi kerak).
 */
export const PERMISSIONS = [
  'payroll.view',
  'payroll.approve',
  'payments.view',
  'payments.edit',
  'attendance.view',
  'employees.edit',
  'reports.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Har bir rol uchun STANDART ruxsatlar — bu ro'yxat mavjud @Roles()
 * dekoratorlarida ishlatilgan rollarni AYNAN takrorlaydi (payroll,
 * payments, attendance, employees, reports modullaridagi hozirgi
 * @Roles ro'yxatlariga qarab tuzilgan) — shuning uchun bu qatlam
 * joriy etilgan kunda hech kim uchun hech narsa o'zgarmaydi.
 *
 * `UserPermissionOverride` yozuvi bo'lmagan foydalanuvchi uchun aynan
 * shu ro'yxat ishlatiladi.
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.SUPER_ADMIN]: [...PERMISSIONS],
  [UserRole.ASSISTANT_ADMIN]: [
    'payroll.view',
    'payments.view',
    'payments.edit',
    'attendance.view',
    'employees.edit',
    'reports.view',
  ],
  [UserRole.ADMIN]: [
    'payroll.view',
    'payroll.approve',
    'attendance.view',
    'employees.edit',
    'reports.view',
  ],
  [UserRole.DIRECTOR]: [
    'payroll.view',
    'payroll.approve',
    'attendance.view',
    'employees.edit',
    'reports.view',
  ],
  [UserRole.DEPARTMENT_HEAD]: ['attendance.view', 'reports.view'],
  [UserRole.EMPLOYEE]: [],
  [UserRole.MINISTRY]: [],
};

/**
 * Rol standarti + shu foydalanuvchi uchun saqlangan override'larni
 * birlashtirib, YAKUNIY (effektiv) ruxsatlar ro'yxatini qaytaradi.
 * `granted: true` — standartga QO'SHIMCHA beriladi, `granted: false` —
 * standartdan OLIB TASHLANADI. Noma'lum (katalogda yo'q) permission
 * qatorlari e'tiborsiz qoldiriladi (masalan eski/o'chirilgan ruxsat nomi).
 */
export function computeEffectivePermissions(
  role: UserRole,
  overrides: { permission: string; granted: boolean }[],
): Permission[] {
  const effective = new Set<Permission>(ROLE_DEFAULT_PERMISSIONS[role] ?? []);
  for (const o of overrides) {
    if (!isPermission(o.permission)) continue;
    if (o.granted) {
      effective.add(o.permission);
    } else {
      effective.delete(o.permission);
    }
  }
  return Array.from(effective);
}
