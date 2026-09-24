import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { CronService } from '../../cron/cron.service';
import { runWithCronLock } from './cron-lock';

describe('CronLock', () => {
  it('@Cron metadata dekoratordan keyin ham saqlanadi (vazifa ro‘yxatdan o‘tadi)', () => {
    const fn = (CronService.prototype as any).markAbsentDaily;
    const opts = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, fn);
    expect(opts?.cronTime).toBe('0 21 * * *');
  });

  it('qulf olinmasa vazifa bajarilmaydi', async () => {
    const db = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const fn = jest.fn();
    const res = await runWithCronLock(db as any, 'x', 1000, fn);
    expect(res).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('qulf olinsa bajariladi va xato bo‘lsa ham qulf qaytariladi', async () => {
    const db = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await expect(
      runWithCronLock(db as any, 'x', 1000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("baza xatosida vazifa o'tkaziladi, jarayon yiqilmaydi", async () => {
    const db = { $executeRaw: jest.fn().mockRejectedValue(new Error('db')) };
    const fn = jest.fn();
    const logger = { warn: jest.fn() };
    await expect(
      runWithCronLock(db as any, 'x', 1000, fn, logger),
    ).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('dekorator: prisma.$executeRaw bo‘lmasa (testlar) asl metod ishlaydi', async () => {
    const svc: any = Object.create(CronService.prototype);
    svc.prisma = {};
    svc.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    svc.attendanceService = {
      markAbsentForToday: jest.fn().mockResolvedValue({ marked: 0 }),
    };
    await svc.markAbsentDaily();
    expect(svc.attendanceService.markAbsentForToday).toHaveBeenCalled();
  });
});
