import { UserRole } from '@prisma/client';
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  isPermission,
  computeEffectivePermissions,
} from './permissions';

describe('permissions katalogi', () => {
  it("har bir rol uchun ROLE_DEFAULT_PERMISSIONS faqat katalogdagi ruxsatlarni o'z ichiga oladi", () => {
    for (const role of Object.values(UserRole)) {
      const perms = ROLE_DEFAULT_PERMISSIONS[role] ?? [];
      for (const p of perms) {
        expect((PERMISSIONS as readonly string[]).includes(p)).toBe(true);
      }
    }
  });

  it('SUPER_ADMIN barcha katalogdagi ruxsatlarga ega', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[UserRole.SUPER_ADMIN].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
  });

  it("EMPLOYEE va MINISTRY uchun standart ruxsatlar bo'sh (bu tizim admin-panel darajasidagi ruxsatlar uchun)", () => {
    expect(ROLE_DEFAULT_PERMISSIONS[UserRole.EMPLOYEE]).toEqual([]);
    expect(ROLE_DEFAULT_PERMISSIONS[UserRole.MINISTRY]).toEqual([]);
  });

  it('isPermission — katalogdagi qiymatlarni tasdiqlaydi, boshqasini rad etadi', () => {
    expect(isPermission('payroll.view')).toBe(true);
    expect(isPermission('no-such-permission')).toBe(false);
  });
});

describe('computeEffectivePermissions', () => {
  it("override bo'lmasa, aynan rol standartini qaytaradi", () => {
    const effective = computeEffectivePermissions(UserRole.DIRECTOR, []);
    expect(effective.sort()).toEqual(
      [...ROLE_DEFAULT_PERMISSIONS[UserRole.DIRECTOR]].sort(),
    );
  });

  it('granted:false — standartdagi ruxsatni olib tashlaydi', () => {
    const effective = computeEffectivePermissions(UserRole.DIRECTOR, [
      { permission: 'payroll.approve', granted: false },
    ]);
    expect(effective).not.toContain('payroll.approve');
    // boshqa standart ruxsatlar tegilmagan qoladi
    expect(effective).toContain('payroll.view');
  });

  it("granted:true — standartda yo'q ruxsatni qo'shadi", () => {
    // DIRECTOR standart bo'yicha payments.view'ga ega emas
    const effective = computeEffectivePermissions(UserRole.DIRECTOR, [
      { permission: 'payments.view', granted: true },
    ]);
    expect(effective).toContain('payments.view');
  });

  it("katalogda yo'q (noma'lum) permission qatorlari e'tiborsiz qoldiriladi", () => {
    const effective = computeEffectivePermissions(UserRole.DIRECTOR, [
      { permission: 'old.removed.permission', granted: true },
    ]);
    expect(effective).not.toContain('old.removed.permission');
  });
});
