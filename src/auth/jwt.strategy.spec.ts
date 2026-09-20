import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';

/**
 * JwtStrategy uchun unit test — asosiy maqsad: granular ruxsatlar
 * (FAZA 5, 7-bosqich) validate() natijasiga to'g'ri qo'shilishini
 * tekshirish (computeEffectivePermissions orqali, qo'shimcha DB
 * chaqiruvisiz — bir xil `findUnique` so'rovi ichida).
 */
function makeFakePrisma(user: any) {
  return {
    user: {
      findUnique: jest.fn(async () => user),
    },
  } as unknown as PrismaService;
}

function makeStrategy(prisma: PrismaService) {
  const config = { get: () => 'test-secret' } as unknown as ConfigService;
  return new JwtStrategy(config, prisma);
}

describe('JwtStrategy', () => {
  it("faol DIRECTOR uchun rol standarti bo'yicha effektiv ruxsatlarni qo'shadi (override yo'q)", async () => {
    const prisma = makeFakePrisma({
      id: 'u1',
      role: 'DIRECTOR',
      status: 'ACTIVE',
      username: 'dir',
      hospitalId: 'h1',
      permissionOverrides: [],
    });
    const strategy = makeStrategy(prisma);

    const result = await strategy.validate({
      sub: 'u1',
      role: 'DIRECTOR',
      username: 'dir',
    });

    expect(result.permissions).toContain('payroll.view');
    expect(result.permissions).not.toContain('payments.view');
  });

  it("saqlangan override natijadagi permissions massivini o'zgartiradi", async () => {
    const prisma = makeFakePrisma({
      id: 'u1',
      role: 'DIRECTOR',
      status: 'ACTIVE',
      username: 'dir',
      hospitalId: 'h1',
      permissionOverrides: [{ permission: 'payroll.approve', granted: false }],
    });
    const strategy = makeStrategy(prisma);

    const result = await strategy.validate({
      sub: 'u1',
      role: 'DIRECTOR',
      username: 'dir',
    });

    expect(result.permissions).not.toContain('payroll.approve');
  });

  it('foydalanuvchi topilmasa, UnauthorizedException tashlaydi', async () => {
    const prisma = makeFakePrisma(null);
    const strategy = makeStrategy(prisma);

    await expect(
      strategy.validate({ sub: 'no-such', role: 'EMPLOYEE', username: 'x' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('SUSPENDED foydalanuvchi uchun UnauthorizedException tashlaydi', async () => {
    const prisma = makeFakePrisma({
      id: 'u1',
      role: 'EMPLOYEE',
      status: 'SUSPENDED',
      username: 'emp',
      hospitalId: 'h1',
      permissionOverrides: [],
    });
    const strategy = makeStrategy(prisma);

    await expect(
      strategy.validate({ sub: 'u1', role: 'EMPLOYEE', username: 'emp' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('parol yangilangach undan oldin berilgan tokenni rad etadi', async () => {
    const prisma = makeFakePrisma({
      id: 'u1',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      username: 'emp',
      hospitalId: 'h1',
      credentialsChangedAt: new Date('2026-09-21T03:00:00Z'),
      permissionOverrides: [],
    });
    const strategy = makeStrategy(prisma);

    await expect(
      strategy.validate({
        sub: 'u1',
        role: 'EMPLOYEE',
        username: 'emp',
        iat: Math.floor(new Date('2026-09-21T02:59:59Z').getTime() / 1000),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
