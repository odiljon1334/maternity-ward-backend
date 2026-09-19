import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

function makeContext(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}) as any,
    getClass: () => ({}) as any,
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it("@RequirePermission belgilanmagan bo'lsa, doim ruxsat beradi", () => {
    const reflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(guard.canActivate(makeContext({ permissions: [] }))).toBe(true);
  });

  it("foydalanuvchi kerakli ruxsatga ega bo'lsa, ruxsat beradi", () => {
    const reflector = {
      getAllAndOverride: () => ['payroll.view'],
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(
      guard.canActivate(makeContext({ permissions: ['payroll.view'] })),
    ).toBe(true);
  });

  it("foydalanuvchida kerakli ruxsat yo'q bo'lsa, ForbiddenException tashlaydi", () => {
    const reflector = {
      getAllAndOverride: () => ['payments.view'],
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(() =>
      guard.canActivate(makeContext({ permissions: ['payroll.view'] })),
    ).toThrow(ForbiddenException);
  });

  it('bir nechta ruxsatdan BIRI mos kelsa yetarli (OR mantiq)', () => {
    const reflector = {
      getAllAndOverride: () => ['payroll.view', 'payments.view'],
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(
      guard.canActivate(makeContext({ permissions: ['payments.view'] })),
    ).toBe(true);
  });

  it("user.permissions bo'lmasa (aniqlanmagan holat), ruxsat talab qilinganda rad etadi", () => {
    const reflector = {
      getAllAndOverride: () => ['payroll.view'],
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      ForbiddenException,
    );
  });
});
