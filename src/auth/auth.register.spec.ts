import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService.register — role va tenant chegarasi', () => {
  function setup(options?: {
    hospitalExists?: boolean;
    employee?: { id: string; userId: string | null } | null;
  }) {
    const createdUsers: any[] = [];
    const tx = {
      user: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: any) => {
          const user = {
            id: `u-${createdUsers.length + 1}`,
            ...data,
            status: 'ACTIVE',
            createdAt: new Date(),
          };
          createdUsers.push(user);
          return user;
        }),
      },
      employee: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => null) },
      hospital: {
        findUnique: jest.fn(async () =>
          options?.hospitalExists === false ? null : { id: 'h1' },
        ),
      },
      employee: {
        findFirst: jest.fn(async () => options?.employee ?? null),
      },
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    const auditLog = { log: jest.fn() };
    const service = new AuthService(
      prisma as any,
      {} as any,
      auditLog as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, tx, auditLog, createdUsers };
  }

  it('SUPER_ADMIN hisobini ushbu oqimdan yaratmaydi', async () => {
    const { service } = setup();
    await expect(
      service.register({
        username: 'ikkinchi_super',
        password: 'Secret123',
        role: UserRole.SUPER_ADMIN,
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ADMIN uchun muassasani majburiy qiladi va hisobga yozadi', async () => {
    const { service, createdUsers } = setup();
    await expect(
      service.register({
        username: 'admin1',
        password: 'Secret123',
        role: UserRole.ADMIN,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    const user = await service.register({
      username: 'admin1',
      password: 'Secret123',
      role: UserRole.ADMIN,
      hospitalId: 'h1',
    } as any);
    expect(user.hospitalId).toBe('h1');
    expect(createdUsers[0].hospitalId).toBe('h1');
  });

  it("EMPLOYEE va DEPARTMENT_HEAD'ni mavjud xodim kartasiga bog'laydi", async () => {
    const { service, tx } = setup({
      employee: { id: 'e1', userId: null },
    });

    await expect(
      service.register({
        username: 'employee1',
        password: 'Secret123',
        role: UserRole.EMPLOYEE,
        hospitalId: 'h1',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    const user = await service.register({
      username: 'employee1',
      password: 'Secret123',
      role: UserRole.EMPLOYEE,
      hospitalId: 'h1',
      employeeId: 'e1',
    } as any);
    expect(tx.employee.updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', userId: null },
      data: { userId: user.id },
    });
  });

  it('DIRECTOR yaratishda eski direktorni saqlagan holda EMPLOYEE roliga tushiradi', async () => {
    const { service, tx } = setup();
    await service.register({
      username: 'director2',
      password: 'Secret123',
      role: UserRole.DIRECTOR,
      hospitalId: 'h1',
    } as any);

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { hospitalId: 'h1', role: UserRole.DIRECTOR },
      data: { role: UserRole.EMPLOYEE },
    });
  });
});
