import { clearHospitalBlockCache, isHospitalBlocked } from './payment.util';
import { getMonthlyExpectedAmount } from './pricing.util';

describe('isHospitalBlocked — avto-blok', () => {
  const NOW = new Date('2026-09-24T10:00:00+05:00');
  const ENV = { ...process.env };

  function prismaWith(
    payments: any[],
    opts: { isBlocked?: boolean; createdAt?: Date; employees?: number } = {},
  ) {
    return {
      hospital: {
        findUnique: jest.fn(async () => ({
          isBlocked: !!opts.isBlocked,
          createdAt: opts.createdAt ?? new Date('2025-01-01T00:00:00Z'),
        })),
      },
      employee: { count: jest.fn(async () => opts.employees ?? 20) },
      payment: { findMany: jest.fn(async () => payments) },
    } as any;
  }

  beforeEach(() => clearHospitalBlockCache());
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("qo'lda blok har doim ishlaydi", async () => {
    await expect(
      isHospitalBlocked(prismaWith([], { isBlocked: true }), 'h1', NOW),
    ).resolves.toBe(true);
  });

  it("BILLING_AUTO_BLOCK yoqilmagan bo'lsa — qarz bo'lsa ham bloklanmaydi (standart)", async () => {
    delete process.env.BILLING_AUTO_BLOCK;
    await expect(isHospitalBlocked(prismaWith([]), 'h1', NOW)).resolves.toBe(
      false,
    );
  });

  describe('BILLING_AUTO_BLOCK=true', () => {
    beforeEach(() => {
      process.env.BILLING_AUTO_BLOCK = 'true';
      delete process.env.BILLING_GRACE_DAYS;
      delete process.env.BILLING_TRIAL_DAYS;
    });

    it("avgust to'lanmagan, imtiyoz (10 kun) o'tgan — bloklanadi", async () => {
      const full = getMonthlyExpectedAmount(20);
      const payments = [
        { period: '2026-06', months: 1, amount: full },
        { period: '2026-07', months: 1, amount: full },
      ];
      await expect(
        isHospitalBlocked(prismaWith(payments), 'h1', NOW),
      ).resolves.toBe(true);
    });

    it('imtiyozli muddat ichida (oy tugaganiga 5 kun) — bloklanmaydi', async () => {
      const full = getMonthlyExpectedAmount(20);
      const payments = [
        { period: '2026-06', months: 1, amount: full },
        { period: '2026-07', months: 1, amount: full },
      ];
      const early = new Date('2026-09-05T10:00:00+05:00');
      await expect(
        isHospitalBlocked(prismaWith(payments), 'h1', early),
      ).resolves.toBe(false);
    });

    it("yillik to'lov bilan qoplangan — bloklanmaydi", async () => {
      const payments = [{ period: '2026-01', months: 12, amount: 1 }];
      await expect(
        isHospitalBlocked(prismaWith(payments), 'h1', NOW),
      ).resolves.toBe(false);
    });

    it("yangi ulangan muassasa (sinov davri) — o'tgan oylar uchun bloklanmaydi", async () => {
      const prisma = prismaWith([], {
        createdAt: new Date('2026-08-25T00:00:00Z'),
      });
      await expect(isHospitalBlocked(prisma, 'h1', NOW)).resolves.toBe(false);
    });

    it("xodimi yo'q muassasa — bloklanmaydi", async () => {
      await expect(
        isHospitalBlocked(prismaWith([], { employees: 0 }), 'h1', NOW),
      ).resolves.toBe(false);
    });
  });
});
