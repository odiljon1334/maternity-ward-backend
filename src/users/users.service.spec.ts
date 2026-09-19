import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * UsersService uchun servis-darajasidagi unit testlar (FAZA 5 / 5-bosqich —
 * Foydalanuvchilarni boshqarish paneli). HAQIQIY bazasiz — payments.service.spec.ts
 * bilan bir xil soxta-Prisma naqshi.
 */

function makeFakePrisma() {
  const users: any[] = [];

  return {
    __state: { users },

    user: {
      findMany: jest.fn(async ({ where, skip = 0, take = 20 }: any) => {
        let result = users;
        if (where?.hospitalId) {
          result = result.filter((u) => u.hospitalId === where.hospitalId);
        }
        if (where?.role) result = result.filter((u) => u.role === where.role);
        if (where?.status)
          result = result.filter((u) => u.status === where.status);
        return result.slice(skip, skip + take);
      }),
      count: jest.fn(async ({ where }: any) => {
        let result = users;
        if (where?.hospitalId) {
          result = result.filter((u) => u.hospitalId === where.hospitalId);
        }
        return result.length;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          users.find(
            (u) =>
              u.id === where.id &&
              (!where.hospitalId || u.hospitalId === where.hospitalId),
          ) ?? null
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const u of users) {
          if (
            u.hospitalId === where.hospitalId &&
            u.role === where.role &&
            u.id !== where.id.not
          ) {
            Object.assign(u, data);
            count++;
          }
        }
        return { count };
      }),
    },
  } as any;
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makeFakePrisma>;

  beforeEach(async () => {
    prisma = makeFakePrisma();
    // $transaction'ga tx sifatida xuddi asosiy prisma obyektini beramiz —
    // fake implementatsiyada user.* metodlari bir xil.
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(UsersService);
  });

  describe('findAll', () => {
    it('hospitalId berilsa, faqat shu shifoxona foydalanuvchilarini qaytaradi', async () => {
      prisma.__state.users.push(
        {
          id: 'u1',
          hospitalId: 'h1',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          username: 'a',
        },
        {
          id: 'u2',
          hospitalId: 'h2',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          username: 'b',
        },
      );

      const result = await service.findAll({} as any, 'h1');

      expect(result.meta.total).toBe(1);
      expect(result.data[0].id).toBe('u1');
    });

    it('hospitalId null bo‘lsa (SUPER_ADMIN), barcha foydalanuvchilarni qaytaradi', async () => {
      prisma.__state.users.push(
        {
          id: 'u1',
          hospitalId: 'h1',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          username: 'a',
        },
        {
          id: 'u2',
          hospitalId: 'h2',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          username: 'b',
        },
      );

      const result = await service.findAll({} as any, null);

      expect(result.meta.total).toBe(2);
    });
  });

  describe('updateStatus', () => {
    it("mavjud bo'lmagan foydalanuvchida NotFoundException tashlaydi", async () => {
      await expect(
        service.updateStatus('no-such-user', 'SUSPENDED' as any, null),
      ).rejects.toThrow(NotFoundException);
    });

    it('SUPER_ADMIN holatini o‘zgartirishga urinishda BadRequestException tashlaydi', async () => {
      prisma.__state.users.push({
        id: 'u1',
        hospitalId: null,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        username: 'root',
      });

      await expect(
        service.updateStatus('u1', 'SUSPENDED' as any, null),
      ).rejects.toThrow(BadRequestException);
    });

    it("oddiy xodimning holatini muvaffaqiyatli o'zgartiradi", async () => {
      prisma.__state.users.push({
        id: 'u1',
        hospitalId: 'h1',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        username: 'a',
      });

      const updated = await service.updateStatus(
        'u1',
        'SUSPENDED' as any,
        'h1',
      );

      expect(updated.status).toBe('SUSPENDED');
    });
  });

  describe('updateRole', () => {
    it('SUPER_ADMIN/MINISTRY rolini tayinlashga urinishda BadRequestException tashlaydi', async () => {
      prisma.__state.users.push({
        id: 'u1',
        hospitalId: 'h1',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        username: 'a',
      });

      await expect(
        service.updateRole('u1', 'SUPER_ADMIN' as any, 'h1'),
      ).rejects.toThrow(BadRequestException);
    });

    it("yangi DIRECTOR tayinlanganda, eski direktor avtomatik EMPLOYEE'ga tushadi", async () => {
      prisma.__state.users.push(
        {
          id: 'old-dir',
          hospitalId: 'h1',
          role: 'DIRECTOR',
          status: 'ACTIVE',
          username: 'old',
        },
        {
          id: 'new-dir',
          hospitalId: 'h1',
          role: 'DEPARTMENT_HEAD',
          status: 'ACTIVE',
          username: 'new',
        },
      );

      const updated = await service.updateRole(
        'new-dir',
        'DIRECTOR' as any,
        'h1',
      );

      expect(updated.role).toBe('DIRECTOR');
      const oldDir = prisma.__state.users.find((u) => u.id === 'old-dir');
      expect(oldDir.role).toBe('EMPLOYEE');
    });
  });
});
