import { CronService } from './cron.service';

describe('CronService.autoCloseMissingCheckoutsCron', () => {
  it('23:50 da avtomatik yopilgan har bir xodim uchun Directorga ogohlantirish yuboradi', async () => {
    const expectedCheckOut = new Date('2026-09-22T17:00:00+05:00');
    const closed = {
      recordId: 'attendance-1',
      employeeId: 'employee-1',
      employeeName: 'Test Xodim',
      hospitalId: 'hospital-1',
      expectedCheckOut,
    };
    const attendanceService = {
      autoCloseMissingCheckouts: jest.fn().mockResolvedValue([closed]),
    };
    const pushService = {
      notifyMissedCheckout: jest.fn().mockResolvedValue(undefined),
    };
    const telegramService = {
      notifyMissedCheckout: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CronService(
      attendanceService as any,
      telegramService as any,
      {} as any,
      {} as any,
      {} as any,
      pushService as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.autoCloseMissingCheckoutsCron();

    expect(attendanceService.autoCloseMissingCheckouts).toHaveBeenCalledTimes(
      1,
    );
    expect(pushService.notifyMissedCheckout).toHaveBeenCalledWith(
      'hospital-1',
      'employee-1',
      'Test Xodim',
      'attendance-1',
      expectedCheckOut,
    );
    expect(telegramService.notifyMissedCheckout).toHaveBeenCalledWith(
      'hospital-1',
      'Test Xodim',
      expectedCheckOut,
    );
  });

  it('bitta xabar kanali ishlamasa qolgan jarayonni to‘xtatmaydi', async () => {
    const closed = {
      recordId: 'attendance-1',
      employeeId: 'employee-1',
      employeeName: 'Test Xodim',
      hospitalId: 'hospital-1',
      expectedCheckOut: new Date('2026-09-22T17:00:00+05:00'),
    };
    const attendanceService = {
      autoCloseMissingCheckouts: jest.fn().mockResolvedValue([closed]),
    };
    const pushService = {
      notifyMissedCheckout: jest.fn().mockRejectedValue(new Error('push down')),
    };
    const telegramService = {
      notifyMissedCheckout: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CronService(
      attendanceService as any,
      telegramService as any,
      {} as any,
      {} as any,
      {} as any,
      pushService as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.autoCloseMissingCheckoutsCron(),
    ).resolves.toBeUndefined();
    expect(telegramService.notifyMissedCheckout).toHaveBeenCalledTimes(1);
  });
});
