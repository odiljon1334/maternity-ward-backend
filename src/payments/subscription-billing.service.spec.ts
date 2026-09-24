import { Prisma } from '@prisma/client';
import {
  SubscriptionBillingService,
  UZS_MINOR_UNITS,
} from './subscription-billing.service';
import { getStaffPricing } from '../common/utils/pricing.util';

/**
 * Telegram obuna to'lovi — haqiqiy pul harakatlanadigan joy.
 * Tekshiriladi: summa tiyinda (×100), invoys summasini/muddatini o'zgartirib
 * bo'lmasligi, eskirgan/eski formatdagi invoys rad etilishi, bir to'lov ikki
 * marta yozilmasligi.
 */
describe('SubscriptionBillingService', () => {
  const NOW = new Date('2026-09-24T10:00:00+05:00');

  function setup(
    opts: {
      employees?: number;
      lastPaid?: string | null;
      nextPeriod?: string;
      annualStart?: string;
      covered?: string[];
    } = {},
  ) {
    const invoices: any[] = [];
    const payments: any[] = [];
    const prisma: any = {
      hospital: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'h1'
            ? { id: 'h1', isActive: true, name: 'Klinika' }
            : null,
        ),
      },
      subscriptionInvoice: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const i of invoices) {
            if (
              i.hospitalId === where.hospitalId &&
              (where.chatId === undefined || i.chatId === where.chatId) &&
              i.status === where.status
            ) {
              Object.assign(i, data);
              count++;
            }
          }
          return { count };
        }),
        create: jest.fn(async ({ data }: any) => {
          const inv = {
            id: `inv-${invoices.length + 1}`,
            status: 'OPEN',
            currency: 'UZS',
            ...data,
          };
          invoices.push(inv);
          return { id: inv.id };
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          const inv = invoices.find((i) => i.id === where.id);
          return inv ? { ...inv, hospital: { isActive: true } } : null;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const inv = invoices.find((i) => i.id === where.id);
          Object.assign(inv, data);
          return inv;
        }),
      },
      payment: {
        findFirst: jest.fn(
          async ({ where }: any) =>
            payments.find(
              (x) => x.invoiceId && x.invoiceId === where.invoiceId,
            ) ?? null,
        ),
        findUnique: jest.fn(async ({ where }: any) => {
          const p = payments.find(
            (x) => x.telegramPaymentId === where.telegramPaymentId,
          );
          return p ? { ...p, hospital: { name: 'Klinika' } } : null;
        }),
        create: jest.fn(async ({ data }: any) => {
          if (
            payments.some((x) => x.telegramPaymentId === data.telegramPaymentId)
          ) {
            throw new Prisma.PrismaClientKnownRequestError('dup', {
              code: 'P2002',
              clientVersion: 'x',
            });
          }
          const p = { id: `pay-${payments.length + 1}`, ...data };
          payments.push(p);
          return { ...p, hospital: { name: 'Klinika' } };
        }),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      $queryRaw: jest.fn(async () => [{ ok: 1 }]),
    };
    const employeeCount = opts.employees ?? 20;
    const paymentsService: any = {
      getBillingState: jest.fn(async () => ({
        employeeCount,
        expectedMonthly: 0,
        lastPaidPeriod: opts.lastPaid ?? null,
        paidThrough: null,
        nextPeriod: opts.nextPeriod ?? '2026-09',
        annualStart: opts.annualStart ?? opts.nextPeriod ?? '2026-09',
        overduePeriods: [],
        coveredPeriods: opts.covered ?? [],
      })),
    };
    const svc = new SubscriptionBillingService(prisma, paymentsService);
    return { svc, prisma, invoices, payments, paymentsService };
  }

  it("invoys summasi Telegram uchun tiyinda (so'm × 100) va serverda saqlanadi", async () => {
    const { svc, invoices } = setup({ employees: 20 });
    const res: any = await svc.createInvoice('h1', 'chat-1', 'MONTHLY', NOW);
    const expectedSom = getStaffPricing(20).monthlyTotal!;
    expect(res.ok).toBe(true);
    expect(res.amountSom).toBe(expectedSom);
    expect(res.amountMinor).toBe(expectedSom * UZS_MINOR_UNITS);
    expect(res.payload).toBe(`inv:${invoices[0].id}`);
    expect(invoices[0]).toMatchObject({
      months: 1,
      startPeriod: '2026-09',
      amount: expectedSom,
    });
  });

  it("yillik invoys 12 oyni keyingi to'lanmagan oydan boshlab qoplaydi", async () => {
    const { svc } = setup({
      employees: 20,
      nextPeriod: '2026-07',
      annualStart: '2026-11',
    });
    const res: any = await svc.createInvoice('h1', 'chat-1', 'ANNUAL', NOW);
    expect(res.months).toBe(12);
    expect(res.coverage).toBe('Noyabr 2026 – Oktabr 2027');
    expect(res.amountSom).toBe(getStaffPricing(20).annualTotal);
  });

  it('yangi invoys shu shifoxonaning barcha eski ochiq invoyslarini yopadi (boshqa chatnikini ham)', async () => {
    const { svc, invoices } = setup();
    await svc.createInvoice('h1', 'chat-1', 'MONTHLY', NOW);
    await svc.createInvoice('h1', 'chat-2', 'MONTHLY', NOW);
    expect(invoices.map((i) => i.status)).toEqual(['EXPIRED', 'OPEN']);
  });

  it('500+ xodim — avtomatik invoys yaratilmaydi', async () => {
    const { svc, invoices } = setup({ employees: 600 });
    const res: any = await svc.createInvoice('h1', 'chat-1', 'MONTHLY', NOW);
    expect(res).toEqual({ ok: false, reason: 'NEGOTIATED' });
    expect(invoices).toHaveLength(0);
  });

  describe('pre_checkout', () => {
    async function withInvoice(opts: any = {}) {
      const ctx = setup(opts);
      const inv: any = await ctx.svc.createInvoice(
        'h1',
        'chat-1',
        'MONTHLY',
        NOW,
      );
      return { ...ctx, inv };
    }

    it("to'g'ri invoys va aynan mos summa — tasdiqlanadi", async () => {
      const { svc, inv } = await withInvoice();
      await expect(
        svc.validatePreCheckout(
          {
            payload: inv.payload,
            currency: 'UZS',
            totalAmount: inv.amountMinor,
          },
          NOW,
        ),
      ).resolves.toEqual({ ok: true });
    });

    it("summa o'zgargan bo'lsa (masalan so'mda, ×100 siz) — rad etiladi", async () => {
      const { svc, inv } = await withInvoice();
      const res: any = await svc.validatePreCheckout(
        { payload: inv.payload, currency: 'UZS', totalAmount: inv.amountSom },
        NOW,
      );
      expect(res.ok).toBe(false);
    });

    it('eski formatdagi payload ("MONTHLY:<id>") — rad etiladi', async () => {
      const { svc } = setup();
      const res: any = await svc.validatePreCheckout(
        { payload: 'MONTHLY:h1', currency: 'UZS', totalAmount: 100 },
        NOW,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/eskirgan/);
    });

    it("muddati o'tgan invoys — rad etiladi", async () => {
      const { svc, inv } = await withInvoice();
      const later = new Date(NOW.getTime() + 25 * 3600_000);
      const res: any = await svc.validatePreCheckout(
        { payload: inv.payload, currency: 'UZS', totalAmount: inv.amountMinor },
        later,
      );
      expect(res.ok).toBe(false);
    });

    it("shu oylar boshqa to'lov bilan yopilgan bo'lsa — ikkinchi marta pul olinmaydi", async () => {
      const { svc, inv, paymentsService, invoices } = await withInvoice();
      paymentsService.getBillingState.mockResolvedValue({
        lastPaidPeriod: '2026-09',
        nextPeriod: '2026-10',
        coveredPeriods: ['2026-09'],
      });
      const res: any = await svc.validatePreCheckout(
        { payload: inv.payload, currency: 'UZS', totalAmount: inv.amountMinor },
        NOW,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/allaqachon to'langan/);
      expect(invoices[0].status).toBe('EXPIRED');
    });
  });

  describe("muvaffaqiyatli to'lov", () => {
    it("summa so'mga qaytariladi (÷100), qoplama va invoys PAID bo'ladi", async () => {
      const ctx = setup();
      const inv: any = await ctx.svc.createInvoice(
        'h1',
        'chat-1',
        'MONTHLY',
        NOW,
      );
      const res: any = await ctx.svc.recordSuccessfulPayment(
        {
          payload: inv.payload,
          currency: 'UZS',
          totalAmount: inv.amountMinor,
          telegramChargeId: 'tg-1',
          providerChargeId: 'click-1',
          chatId: 'chat-1',
          payerName: 'Direktor',
        },
        NOW,
      );
      expect(res.status).toBe('RECORDED');
      expect(ctx.payments[0]).toMatchObject({
        amount: inv.amountSom,
        months: 1,
        period: '2026-09',
        status: 'PAID',
        telegramPaymentId: 'tg-1',
        providerPaymentId: 'click-1',
        invoiceId: inv.invoiceId,
      });
      expect(ctx.invoices[0].status).toBe('PAID');
    });

    it('bir charge id ikkinchi marta kelsa — yangi yozuv yaratilmaydi', async () => {
      const ctx = setup();
      const inv: any = await ctx.svc.createInvoice(
        'h1',
        'chat-1',
        'MONTHLY',
        NOW,
      );
      const input = {
        payload: inv.payload,
        currency: 'UZS',
        totalAmount: inv.amountMinor,
        telegramChargeId: 'tg-1',
        chatId: 'chat-1',
        payerName: 'D',
      };
      await ctx.svc.recordSuccessfulPayment(input, NOW);
      const second: any = await ctx.svc.recordSuccessfulPayment(input, NOW);
      expect(second.status).toBe('DUPLICATE');
      expect(ctx.payments).toHaveLength(1);
    });

    it("bir vaqtda boshqa to'lov shu oyni yopgan bo'lsa — pul keyingi bo'sh oyga o'tadi", async () => {
      const ctx = setup();
      const inv: any = await ctx.svc.createInvoice(
        'h1',
        'chat-1',
        'MONTHLY',
        NOW,
      );
      // Invoys yaratilgach operator sentyabrni qo'lda yopdi
      ctx.paymentsService.getBillingState.mockResolvedValue({
        employeeCount: 20,
        nextPeriod: '2026-10',
        annualStart: '2026-10',
        coveredPeriods: ['2026-09'],
      });
      const res: any = await ctx.svc.recordSuccessfulPayment(
        {
          payload: inv.payload,
          currency: 'UZS',
          totalAmount: inv.amountMinor,
          telegramChargeId: 'tg-9',
          chatId: 'chat-1',
          payerName: 'D',
        },
        NOW,
      );
      expect(res.status).toBe('RECORDED');
      expect(ctx.payments[0].period).toBe('2026-10');
      expect(ctx.payments[0].note).toMatch(/o'tkazildi/);
      expect(ctx.prisma.$queryRaw).toHaveBeenCalled(); // shifoxona qulfi
    });

    it("bir invoys ikki xil charge bilan to'lansa — ikkinchisi ham yoziladi, invoysga bog'lanmaydi, belgi qo'yiladi", async () => {
      const ctx = setup();
      const inv: any = await ctx.svc.createInvoice(
        'h1',
        'chat-1',
        'MONTHLY',
        NOW,
      );
      const base = {
        payload: inv.payload,
        currency: 'UZS',
        totalAmount: inv.amountMinor,
        chatId: 'chat-1',
        payerName: 'D',
      };
      await ctx.svc.recordSuccessfulPayment(
        { ...base, telegramChargeId: 'a' },
        NOW,
      );
      const second: any = await ctx.svc.recordSuccessfulPayment(
        { ...base, telegramChargeId: 'b' },
        NOW,
      );
      expect(second.status).toBe('RECORDED');
      expect(ctx.payments).toHaveLength(2);
      expect(ctx.payments[1].invoiceId).toBeNull();
      expect(ctx.payments[1].note).toMatch(/TAKRORIY/);
    });

    it('eski ANNUAL payload — 12 oy emas, 1 oy sifatida yoziladi (summa 100 barobar kam olingan)', async () => {
      const ctx = setup({ nextPeriod: '2026-09' });
      const res: any = await ctx.svc.recordSuccessfulPayment(
        {
          payload: 'ANNUAL:h1',
          currency: 'UZS',
          totalAmount: 3_000_000,
          telegramChargeId: 'tg-ann',
          chatId: 'c',
          payerName: 'D',
        },
        NOW,
      );
      expect(res.months).toBe(1);
      expect(ctx.payments[0]).toMatchObject({ months: 1, invoiceId: null });
      expect(ctx.payments[0].note).toMatch(/ESKI/);
    });

    it("deploy'dan oldingi eski invoys bo'yicha tushgan pul ham yo'qolmaydi (÷100 bilan)", async () => {
      const ctx = setup({ nextPeriod: '2026-09' });
      const res: any = await ctx.svc.recordSuccessfulPayment(
        {
          payload: 'MONTHLY:h1',
          currency: 'UZS',
          totalAmount: 300_000, // eski kod so'mni birlik sifatida yuborgan: 3 000 so'm tushgan
          telegramChargeId: 'tg-old',
          chatId: 'c',
          payerName: 'D',
        },
        NOW,
      );
      expect(res.status).toBe('RECORDED');
      expect(ctx.payments[0]).toMatchObject({
        amount: 3000,
        period: '2026-09',
        invoiceId: null,
      });
    });

    it("noma'lum payload — yozilmaydi, operatorga yo'naltiriladi", async () => {
      const ctx = setup();
      const res = await ctx.svc.recordSuccessfulPayment(
        {
          payload: 'inv:yoq',
          currency: 'UZS',
          totalAmount: 1,
          telegramChargeId: 'x',
          chatId: 'c',
          payerName: 'D',
        },
        NOW,
      );
      expect(res.status).toBe('UNKNOWN_INVOICE');
      expect(ctx.payments).toHaveLength(0);
    });
  });
});
