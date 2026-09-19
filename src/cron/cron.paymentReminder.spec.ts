import { CronService } from './cron.service';

/**
 * CronService.paymentReminderCron() — FAZA 5, 2-bosqich (2026-09-19).
 *
 * Boshqa cron metodlari ko'p og'ir bog'liqlikka ega (Telegraf bot, GPS,
 * schedule mantiqlari) bo'lgani uchun to'liq NestJS TestingModule o'rniga
 * servis to'g'ridan-to'g'ri soxta bog'liqliklar bilan qo'lda quriladi —
 * faqat `paymentReminderCron` chaqiradigan qismlar (`paymentsService`,
 * `telegramService`, `prisma.hospital.findUnique`) haqiqiy ishlaydi.
 */

function makeService(overrides: {
  debtors: any[];
  hospitalState: Record<string, { lastPaymentReminderPeriod: string | null }>;
}) {
  const notifyPaymentReminder = jest.fn().mockResolvedValue(undefined);
  const markPaymentReminderSent = jest.fn(
    async (hospitalId: string, period: string) => {
      overrides.hospitalState[hospitalId] = {
        lastPaymentReminderPeriod: period,
      };
    },
  );

  const fakePrisma: any = {
    hospital: {
      findUnique: jest.fn(async ({ where }: any) => ({
        lastPaymentReminderPeriod:
          overrides.hospitalState[where.id]?.lastPaymentReminderPeriod ?? null,
      })),
    },
  };

  const fakePaymentsService: any = {
    getDebtorsReport: jest.fn().mockResolvedValue(overrides.debtors),
    markPaymentReminderSent,
  };

  const fakeTelegramService: any = { notifyPaymentReminder };

  const service = new CronService(
    {} as any, // attendanceService — bu testda ishlatilmaydi
    fakeTelegramService,
    {} as any, // schedulesService
    fakePrisma,
    {} as any, // leaveService
    {} as any, // pushService
    fakePaymentsService,
  );

  return { service, notifyPaymentReminder, markPaymentReminderSent };
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

describe('CronService.paymentReminderCron', () => {
  it("qarzdor shifoxonaga eslatma yuboradi va 'yuborildi' deb belgilaydi", async () => {
    const { service, notifyPaymentReminder, markPaymentReminderSent } =
      makeService({
        debtors: [
          {
            id: 'h1',
            name: 'Qarzdor klinika',
            consecutiveUnpaidMonths: 2,
            totalDebt: 40_000,
          },
        ],
        hospitalState: {},
      });

    await service.paymentReminderCron();

    expect(notifyPaymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'h1' }),
      { consecutiveUnpaidMonths: 2, totalDebt: 40_000 },
    );
    expect(markPaymentReminderSent).toHaveBeenCalledWith('h1', currentPeriod());
  });

  it("qarzi yo'q shifoxonaga xabar yubormaydi", async () => {
    const { service, notifyPaymentReminder } = makeService({
      debtors: [
        {
          id: 'h1',
          name: 'Toza klinika',
          consecutiveUnpaidMonths: 0,
          totalDebt: 0,
        },
      ],
      hospitalState: {},
    });

    await service.paymentReminderCron();

    expect(notifyPaymentReminder).not.toHaveBeenCalled();
  });

  it("shu oy uchun allaqachon eslatma yuborilgan bo'lsa, qayta yubormaydi", async () => {
    const period = currentPeriod();
    const { service, notifyPaymentReminder, markPaymentReminderSent } =
      makeService({
        debtors: [
          {
            id: 'h1',
            name: 'Qarzdor klinika',
            consecutiveUnpaidMonths: 3,
            totalDebt: 60_000,
          },
        ],
        hospitalState: { h1: { lastPaymentReminderPeriod: period } },
      });

    await service.paymentReminderCron();

    expect(notifyPaymentReminder).not.toHaveBeenCalled();
    expect(markPaymentReminderSent).not.toHaveBeenCalled();
  });

  it("o'tgan oyda eslatma yuborilgan bo'lsa, joriy oyda qayta yuboradi", async () => {
    const { service, notifyPaymentReminder } = makeService({
      debtors: [
        {
          id: 'h1',
          name: 'Qarzdor klinika',
          consecutiveUnpaidMonths: 4,
          totalDebt: 80_000,
        },
      ],
      hospitalState: { h1: { lastPaymentReminderPeriod: '2000-01' } },
    });

    await service.paymentReminderCron();

    expect(notifyPaymentReminder).toHaveBeenCalledTimes(1);
  });
});
