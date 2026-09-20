import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { getMonthlyExpectedAmount } from '../common/utils/pricing.util';

/**
 * PaymentsService uchun servis-darajasidagi (unit) testlar — Faza 3.4
 * ("payment" qismi).
 *
 * HAQIQIY bazasiz ishlaydi (auth.service.spec.ts'dagi kabi PrismaService
 * xotiradagi soxta ma'lumotlar bilan almashtiriladi). Maqsad: kasalxonalar
 * bo'yicha to'lov holati (PAID/PENDING), kutilayotgan summa hisoblash
 * (xodimlar soni * narx) va to'lov yaratish/yangilash mantig'i to'g'ri
 * ishlashini tekshirish — bular to'g'ridan-to'g'ri moliyaviy hisobotga
 * ta'sir qiladi.
 */

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function makeFakePrisma() {
  const hospitals: any[] = [];
  const payments: any[] = [];
  const users: any[] = [];
  let idCounter = 1;

  return {
    __state: { hospitals, payments, users },

    hospital: {
      findMany: jest.fn(async ({ where }: any) => {
        return hospitals
          .filter((h) => !where?.isActive || h.isActive === where.isActive)
          .map((h) => ({
            id: h.id,
            name: h.name,
            code: h.code,
            isActive: h.isActive,
            _count: {
              employees: h.employees.filter((e: any) => !e.firedAt).length,
            },
            payments: payments
              .filter((p) => p.hospitalId === h.id)
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 5),
          }));
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const h = hospitals.find((x) => x.id === where.id);
        return h ? { id: h.id } : null;
      }),
    },

    user: {
      count: jest.fn(async ({ where }: any) => {
        return users.filter((u) => {
          if (where?.lastLoginAt?.gte) {
            return u.lastLoginAt && u.lastLoginAt >= where.lastLoginAt.gte;
          }
          return true;
        }).length;
      }),
      groupBy: jest.fn(async ({ by }: any) => {
        const map = new Map<string, number>();
        for (const u of users) {
          const key = by.map((k: string) => u[k]).join('|');
          map.set(key, (map.get(key) ?? 0) + 1);
        }
        return Array.from(map.entries()).map(([key, count]) => {
          const parts = key.split('|');
          const result: any = {};
          by.forEach((k: string, i: number) => {
            result[k] = parts[i];
          });
          result._count = { _all: count };
          return result;
        });
      }),
    },

    payment: {
      // Umumiy groupBy — getOverview() (by:['hospitalId']) VA
      // getDebtorsReport() (by:['hospitalId','period'], `in` filtrlar,
      // `_max`) ikkalasini ham qamrab oladi.
      groupBy: jest.fn(async ({ where, by, _sum, _max }: any) => {
        const matches = (p: any) => {
          if (
            where?.period &&
            typeof where.period === 'string' &&
            p.period !== where.period
          )
            return false;
          if (where?.period?.in && !where.period.in.includes(p.period))
            return false;
          if (
            where?.hospitalId?.in &&
            !where.hospitalId.in.includes(p.hospitalId)
          )
            return false;
          return true;
        };
        const groups = new Map<string, any[]>();
        for (const p of payments) {
          if (!matches(p)) continue;
          const key = by.map((k: string) => p[k]).join('|');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(p);
        }
        return Array.from(groups.entries()).map(([key, rows]) => {
          const keyParts = key.split('|');
          const result: any = {};
          by.forEach((k: string, i: number) => {
            result[k] = keyParts[i];
          });
          if (_sum) {
            result._sum = {};
            for (const field of Object.keys(_sum)) {
              result._sum[field] = rows.reduce(
                (s, r) => s + (r[field] ?? 0),
                0,
              );
            }
          }
          if (_max) {
            result._max = {};
            for (const field of Object.keys(_max)) {
              result._max[field] = rows.reduce(
                (max, r) => (!max || r[field] > max ? r[field] : max),
                null,
              );
            }
          }
          return result;
        });
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        return payments
          .filter((p) => {
            if (where?.hospitalId && p.hospitalId !== where.hospitalId)
              return false;
            if (where?.period && p.period !== where.period) return false;
            return true;
          })
          .slice(0, take ?? payments.length);
      }),
      create: jest.fn(async ({ data }: any) => {
        const p = { id: `pay-${idCounter++}`, createdAt: Date.now(), ...data };
        payments.push(p);
        return p;
      }),
      findUnique: jest.fn(
        async ({ where }: any) =>
          payments.find((p) => p.id === where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const p = payments.find((x) => x.id === where.id);
        Object.assign(p, data);
        return p;
      }),
    },
  };
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: ReturnType<typeof makeFakePrisma>;

  beforeEach(async () => {
    prisma = makeFakePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  describe('getOverview', () => {
    it("xodimlar soniga qarab kutilayotgan summani to'g'ri hisoblaydi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Klinika 1',
        code: 'K1',
        isActive: true,
        employees: [{ firedAt: null }, { firedAt: null }, { firedAt: null }],
      });

      const [overview] = await service.getOverview();

      expect(overview.employeeCount).toBe(3);
      expect(overview.expectedAmount).toBe(getMonthlyExpectedAmount(3));
      expect(overview.paidAmount).toBe(0);
      expect(overview.remainingAmount).toBe(getMonthlyExpectedAmount(3));
      expect(overview.status).toBe('PENDING');
    });

    it("ishdan bo'shatilgan xodimlar (firedAt bor) hisobga olinmaydi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Klinika 1',
        code: 'K1',
        isActive: true,
        employees: [{ firedAt: null }, { firedAt: new Date() }],
      });

      const [overview] = await service.getOverview();

      expect(overview.employeeCount).toBe(1);
      expect(overview.expectedAmount).toBe(getMonthlyExpectedAmount(1));
    });

    it("to'liq to'langan bo'lsa status PAID bo'ladi va remainingAmount 0'da to'xtaydi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Klinika 1',
        code: 'K1',
        isActive: true,
        employees: [{ firedAt: null }, { firedAt: null }],
      });
      prisma.__state.payments.push({
        id: 'pay-existing',
        hospitalId: 'h1',
        amount: getMonthlyExpectedAmount(2), // to'liq (Start tarifi bo'yicha kutilgan summa)
        period: currentPeriod(),
        createdAt: Date.now(),
      });

      const [overview] = await service.getOverview();

      expect(overview.paidAmount).toBe(getMonthlyExpectedAmount(2));
      expect(overview.status).toBe('PAID');
      expect(overview.remainingAmount).toBe(0);
    });

    it("xodimi yo'q kasalxona uchun (expectedAmount=0) status har doim PAID bo'ladi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Bo‘sh klinika',
        code: 'K0',
        isActive: true,
        employees: [],
      });

      const [overview] = await service.getOverview();

      expect(overview.expectedAmount).toBe(0);
      expect(overview.status).toBe('PAID');
    });
  });

  describe('getDebtorsReport', () => {
    function periodsAgo(n: number): string {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    it("hech qachon to'lamagan shifoxona uchun barcha oylar (joriy oy ham) qarzdorlikka kiradi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Qarzdor klinika',
        code: 'QK',
        isActive: true,
        employees: [{ firedAt: null }],
      });

      const [report] = await service.getDebtorsReport(3);

      expect(report.employeeCount).toBe(1);
      expect(report.monthly).toHaveLength(3);
      // Joriy oy hali muddatida — PENDING, o'tganlar — OVERDUE
      expect(report.monthly[2].status).toBe('PENDING');
      expect(report.monthly[0].status).toBe('OVERDUE');
      expect(report.monthly[1].status).toBe('OVERDUE');
      // Uzluksiz to'lanmagan oylar: joriy oy ham hisobga kiradi
      expect(report.consecutiveUnpaidMonths).toBe(3);
      // Jami qarz — faqat MUDDATI O'TGAN (OVERDUE) 2 oy bo'yicha, joriy oy kirmaydi
      expect(report.totalDebt).toBe(2 * getMonthlyExpectedAmount(1));
    });

    it("o'tgan oylarni to'lagan, joriy oyni hali to'lamagan shifoxona uchun uzluksiz seriya faqat joriy oy bilan chegaralanadi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Yaxshi to‘lovchi',
        code: 'YT',
        isActive: true,
        employees: [{ firedAt: null }],
      });
      prisma.__state.payments.push(
        {
          id: 'p1',
          hospitalId: 'h1',
          period: periodsAgo(2),
          amount: getMonthlyExpectedAmount(1),
          createdAt: 1,
        },
        {
          id: 'p2',
          hospitalId: 'h1',
          period: periodsAgo(1),
          amount: getMonthlyExpectedAmount(1),
          createdAt: 2,
        },
      );

      const [report] = await service.getDebtorsReport(3);

      expect(report.consecutiveUnpaidMonths).toBe(1); // faqat joriy oy
      expect(report.totalDebt).toBe(0); // hech qanday OVERDUE oy yo'q
    });

    it("to'liq to'lagan shifoxona uchun qarzdorlik 0 bo'ladi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Namunali klinika',
        code: 'NK',
        isActive: true,
        employees: [{ firedAt: null }],
      });
      for (let i = 0; i < 3; i++) {
        prisma.__state.payments.push({
          id: `pay-${i}`,
          hospitalId: 'h1',
          period: periodsAgo(i),
          amount: getMonthlyExpectedAmount(1),
          createdAt: i,
        });
      }

      const [report] = await service.getDebtorsReport(3);

      expect(report.consecutiveUnpaidMonths).toBe(0);
      expect(report.totalDebt).toBe(0);
      expect(report.monthly.every((m) => m.status === 'PAID')).toBe(true);
    });

    it('eng ko‘p qarzdor shifoxonalar ro‘yxat boshida chiqadi', async () => {
      prisma.__state.hospitals.push(
        {
          id: 'h-debt',
          name: 'Qarzdor',
          code: 'QD',
          isActive: true,
          employees: [{ firedAt: null }],
        },
        {
          id: 'h-clean',
          name: 'Toza',
          code: 'TZ',
          isActive: true,
          employees: [{ firedAt: null }],
        },
      );
      for (let i = 0; i < 3; i++) {
        prisma.__state.payments.push({
          id: `clean-${i}`,
          hospitalId: 'h-clean',
          period: periodsAgo(i),
          amount: getMonthlyExpectedAmount(1),
          createdAt: i,
        });
      }

      const report = await service.getDebtorsReport(3);

      expect(report[0].id).toBe('h-debt');
      expect(report[1].id).toBe('h-clean');
    });

    it('months parametri 1-24 oralig‘ida cheklanadi (masalan 100 -> 24)', async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Klinika',
        code: 'K1',
        isActive: true,
        employees: [],
      });

      const [report] = await service.getDebtorsReport(100);
      expect(report.monthly).toHaveLength(24);
    });
  });

  describe('getPlatformStats', () => {
    function periodsAgo(n: number): string {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    it("joriy oy uchun MRR'ni to'g'ri hisoblaydi va ARR = MRR*12", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'K1',
        code: 'K1',
        isActive: true,
        employees: [],
      });
      prisma.__state.payments.push(
        {
          id: 'p1',
          hospitalId: 'h1',
          period: currentPeriod(),
          amount: 100_000,
          createdAt: 1,
        },
        {
          id: 'p2',
          hospitalId: 'h1',
          period: currentPeriod(),
          amount: 50_000,
          createdAt: 2,
        },
      );

      const stats = await service.getPlatformStats(3);

      expect(stats.mrr).toBe(150_000);
      expect(stats.arr).toBe(150_000 * 12);
      expect(stats.trend).toHaveLength(3);
      expect(stats.trend[stats.trend.length - 1].period).toBe(currentPeriod());
    });

    it("to'lov holati taqsimotini to'g'ri sanaydi", async () => {
      prisma.__state.hospitals.push(
        {
          id: 'h-paid',
          name: 'To‘langan',
          code: 'TL',
          isActive: true,
          employees: [{ firedAt: null }],
        },
        {
          id: 'h-pending',
          name: 'Kutilmoqda',
          code: 'KT',
          isActive: true,
          employees: [{ firedAt: null }],
        },
      );
      prisma.__state.payments.push({
        id: 'p1',
        hospitalId: 'h-paid',
        period: currentPeriod(),
        amount: getMonthlyExpectedAmount(1),
        createdAt: 1,
      });

      const stats = await service.getPlatformStats(3);

      expect(stats.paymentStatusCounts.PAID).toBe(1);
      expect(stats.paymentStatusCounts.PENDING).toBe(1);
      expect(stats.paymentStatusCounts.OVERDUE).toBe(0);
    });

    it("faol foydalanuvchilarni oxirgi 7 kun bo'yicha sanaydi", async () => {
      const now = Date.now();
      prisma.__state.users.push(
        {
          id: 'u1',
          role: 'DIRECTOR',
          lastLoginAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        }, // 2 kun oldin — faol
        {
          id: 'u2',
          role: 'EMPLOYEE',
          lastLoginAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
        }, // 30 kun oldin — nofaol
        { id: 'u3', role: 'EMPLOYEE', lastLoginAt: null },
      );

      const stats = await service.getPlatformStats(3);

      expect(stats.activeUsersCount).toBe(1);
    });

    it("rollar taqsimotini to'g'ri guruhlaydi", async () => {
      prisma.__state.users.push(
        { id: 'u1', role: 'EMPLOYEE' },
        { id: 'u2', role: 'EMPLOYEE' },
        { id: 'u3', role: 'DIRECTOR' },
      );

      const stats = await service.getPlatformStats(3);

      const employeeRow = stats.roleDistribution.find(
        (r) => r.role === 'EMPLOYEE',
      );
      const directorRow = stats.roleDistribution.find(
        (r) => r.role === 'DIRECTOR',
      );
      expect(employeeRow?.count).toBe(2);
      expect(directorRow?.count).toBe(1);
    });

    it("nofaol (isActive:false) shifoxonani churn ro'yxatiga qo'shadi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Yopilgan',
        code: 'YP',
        isActive: false,
        employees: [],
      });

      const stats = await service.getPlatformStats(3);

      expect(
        stats.churn.some((c) => c.id === 'h1' && c.reason === 'INACTIVE'),
      ).toBe(true);
    });

    it("faol lekin oxirgi 2 oyda to'lov qilmagan shifoxonani churn ro'yxatiga qo'shadi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'To‘lamayotgan',
        code: 'TM',
        isActive: true,
        employees: [{ firedAt: null }],
      });
      // Faqat 3 oy oldin to'lagan — oxirgi 2 oyda hech narsa yo'q
      prisma.__state.payments.push({
        id: 'p1',
        hospitalId: 'h1',
        period: periodsAgo(3),
        amount: getMonthlyExpectedAmount(1),
        createdAt: 1,
      });

      const stats = await service.getPlatformStats(6);

      expect(
        stats.churn.some(
          (c) => c.id === 'h1' && c.reason === 'NO_RECENT_PAYMENT',
        ),
      ).toBe(true);
    });

    it("oxirgi 2 oyda to'lagan faol shifoxona churn ro'yxatiga kirmaydi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Yaxshi',
        code: 'YX',
        isActive: true,
        employees: [{ firedAt: null }],
      });
      prisma.__state.payments.push({
        id: 'p1',
        hospitalId: 'h1',
        period: periodsAgo(1),
        amount: getMonthlyExpectedAmount(1),
        createdAt: 1,
      });

      const stats = await service.getPlatformStats(6);

      expect(stats.churn.some((c) => c.id === 'h1')).toBe(false);
    });
  });

  describe('findAll', () => {
    it('hospitalId va period bo‘yicha filtrlaydi', async () => {
      prisma.__state.payments.push(
        {
          id: 'p1',
          hospitalId: 'h1',
          period: '2026-09',
          amount: 1,
          createdAt: 1,
        },
        {
          id: 'p2',
          hospitalId: 'h2',
          period: '2026-09',
          amount: 1,
          createdAt: 2,
        },
        {
          id: 'p3',
          hospitalId: 'h1',
          period: '2026-08',
          amount: 1,
          createdAt: 3,
        },
      );

      const result = await service.findAll({
        hospitalId: 'h1',
        period: '2026-09',
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('p1');
    });

    it("limit ko'rsatilmasa standart 100 qo'llanadi", async () => {
      await service.findAll();
      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('create', () => {
    it("mavjud bo'lmagan kasalxonada NotFoundException tashlaydi", async () => {
      await expect(
        service.create({
          hospitalId: 'no-such-hospital',
          payerName: 'Test',
          amount: 50_000,
          type: 'CASH' as any,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("to'g'ri ma'lumot bilan joriy davr (period) belgilab to'lov yaratadi", async () => {
      prisma.__state.hospitals.push({
        id: 'h1',
        name: 'Klinika 1',
        code: 'K1',
        isActive: true,
        employees: [],
      });

      const payment = await service.create({
        hospitalId: 'h1',
        payerName: 'Aliyev A.',
        amount: 40_000,
        type: 'CASH' as any,
      });

      expect(payment.hospitalId).toBe('h1');
      expect(payment.amount).toBe(40_000);
      expect(payment.period).toBe(currentPeriod());
    });
  });

  describe('update', () => {
    it("mavjud bo'lmagan to'lovda NotFoundException tashlaydi", async () => {
      await expect(
        service.update('no-such-payment', { amount: 1000 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('faqat amount berilsa, note o‘zgarmasdan qoladi (qisman yangilash)', async () => {
      prisma.__state.payments.push({
        id: 'pay-1',
        hospitalId: 'h1',
        amount: 10_000,
        note: 'eski izoh',
        period: currentPeriod(),
        createdAt: Date.now(),
      });

      const updated = await service.update('pay-1', { amount: 99_000 });

      expect(updated.amount).toBe(99_000);
      expect(updated.note).toBe('eski izoh');
    });

    it('faqat note berilsa, amount o‘zgarmasdan qoladi', async () => {
      prisma.__state.payments.push({
        id: 'pay-1',
        hospitalId: 'h1',
        amount: 10_000,
        note: 'eski izoh',
        period: currentPeriod(),
        createdAt: Date.now(),
      });

      const updated = await service.update('pay-1', { note: 'yangi izoh' });

      expect(updated.amount).toBe(10_000);
      expect(updated.note).toBe('yangi izoh');
    });
  });
});
