import { CronService } from './cron.service';

const NOW = new Date('2026-09-26T07:35:00+05:00');
const day = new Date('2026-09-25T19:00:00Z'); // 26-sentabr, Toshkent yarim tuni

function setup(opts: { startTime: string; checkedIn?: boolean; claimed?: boolean }) {
  const employee = { id: 'e1', fullName: 'Karimova Dilnoza', telegramChatId: '555', telegramReminders: true, userId: 'u1' };
  const prisma: any = {
    schedule: {
      findMany: jest.fn(async () => [
        { id: 's1', employeeId: 'e1', date: day, status: 'WORKING', shift: { name: 'Kunduzgi smena', startTime: opts.startTime }, employee },
      ]),
    },
    attendanceRecord: { findFirst: jest.fn(async () => (opts.checkedIn ? { id: 'r1' } : null)) },
    employeeReminderLog: { createMany: jest.fn(async () => ({ count: opts.claimed ? 0 : 1 })) },
  };
  const telegram = { sendCheckinReminder: jest.fn(async () => true) };
  const svc = new CronService({} as any, telegram as any, {} as any, prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, telegram };
}

describe('CronService.sendCheckinReminders', () => {
  it('smena 30 daqiqa ichida boshlansa — eslatma (qolgan daqiqa bilan)', async () => {
    const { svc, telegram, prisma } = setup({ startTime: '08:00' });
    expect(await svc.sendCheckinReminders(NOW)).toBe(1);
    expect(telegram.sendCheckinReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      { start: '08:00', shiftName: 'Kunduzgi smena', minutesLeft: 25 },
    );
    expect(prisma.employeeReminderLog.createMany).toHaveBeenCalledWith({
      data: [{ employeeId: 'e1', kind: 'CHECKIN_SOON', workDate: day }],
      skipDuplicates: true,
    });
  });

  it('hali erta (40 daq) yoki smena boshlangan — yuborilmaydi', async () => {
    for (const startTime of ['08:15', '07:30']) {
      const { svc, telegram } = setup({ startTime });
      expect(await svc.sendCheckinReminders(NOW)).toBe(0);
      expect(telegram.sendCheckinReminder).not.toHaveBeenCalled();
    }
  });

  it('allaqachon kelgan xodimga yuborilmaydi', async () => {
    const { svc, telegram } = setup({ startTime: '08:00', checkedIn: true });
    expect(await svc.sendCheckinReminders(NOW)).toBe(0);
    expect(telegram.sendCheckinReminder).not.toHaveBeenCalled();
  });

  it('bugun allaqachon eslatilgan (boshqa nusxa ham) — takrorlanmaydi', async () => {
    const { svc, telegram } = setup({ startTime: '08:00', claimed: true });
    expect(await svc.sendCheckinReminders(NOW)).toBe(0);
    expect(telegram.sendCheckinReminder).not.toHaveBeenCalled();
  });
});
