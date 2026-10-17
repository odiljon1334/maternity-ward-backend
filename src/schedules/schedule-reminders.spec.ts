import { BadRequestException } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  collectMissingSchedules,
  daysUntilNextMonth,
  missingScheduleMessage,
} from './schedule-reminders';
import { SchedulesService } from './schedules.service';
import { CronService } from '../cron/cron.service';

dayjs.extend(utc);
dayjs.extend(timezone);
const at = (iso: string) => dayjs.tz(`${iso} 10:00`, 'Asia/Tashkent').toDate();
const day = (iso: string) => dayjs.tz(iso, 'Asia/Tashkent').toDate();
const LEAVE = { status: 'VACATION', note: "Ta'til: Yillik ta'til" };

describe('Keyingi oy grafigi: avtomatik ko‘chirish yo‘q, ogohlantirish bor', () => {
  it('oy tugashiga 3 va 2 kun qolganini hisoblaydi', () => {
    expect(daysUntilNextMonth(at('2026-10-29'))).toBe(3);
    expect(daysUntilNextMonth(at('2026-10-30'))).toBe(2);
    expect(daysUntilNextMonth(at('2026-10-31'))).toBe(1);
    expect(daysUntilNextMonth(at('2026-11-28'))).toBe(3);
  });

  it('grafigi yo‘q xodimlar va tasdiqlanmagan postlarni topadi', async () => {
    const prisma: any = {
      hospital: {
        findMany: jest.fn(async () => [
          { id: 'h1', name: 'Poliklinika', schedulePlanningMode: 'STANDARD' },
          {
            id: 'h2',
            name: 'Tug‘ruqxona',
            schedulePlanningMode: 'POST_COVERAGE',
          },
        ]),
      },
      employee: {
        findMany: jest.fn(async () => [
          // grafik kiritilgan
          {
            department: { name: 'Terapiya' },
            schedules: [{ status: 'WORKING', note: null }],
          },
          // umuman grafik yo'q
          { department: { name: 'Terapiya' }, schedules: [] },
          // faqat 10 kunlik ta'til — qolgan kunlar grafiksiz
          {
            department: { name: 'Pediatriya' },
            schedules: Array(10).fill(LEAVE),
          },
          // butun oy ta'tilda — ogohlantirish shart emas
          {
            department: { name: 'Pediatriya' },
            schedules: Array(30).fill(LEAVE),
          },
        ]),
      },
      schedulePost: {
        findMany: jest.fn(async () => [
          { name: 'Doya posti', plans: [{ status: 'APPROVED', version: 1 }] },
          { name: 'Ona va bola', plans: [{ status: 'DRAFT', version: 1 }] },
          { name: 'Reanimatsiya', plans: [] },
        ]),
      },
    };

    const result = await collectMissingSchedules(prisma, 2026, 11);

    expect(result).toEqual([
      {
        hospitalId: 'h1',
        hospitalName: 'Poliklinika',
        employees: {
          total: 2,
          byDepartment: [
            ['Pediatriya', 1],
            ['Terapiya', 1],
          ],
        },
        posts: [],
      },
      {
        hospitalId: 'h2',
        hospitalName: 'Tug‘ruqxona',
        employees: { total: 0, byDepartment: [] },
        posts: [
          { name: 'Ona va bola', state: 'qoralama' },
          { name: 'Reanimatsiya', state: 'yaratilmagan' },
        ],
      },
    ]);
    // Bloklangan muassasalar so'ralmaydi
    expect(prisma.hospital.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isBlocked: false } }),
    );

    const message = missingScheduleMessage(result[0], 2026, 11, 3);
    expect(message.title).toBe('Noyabr oyi grafigi kiritilmagan');
    expect(message.text).toContain("2 ta xodimning noyabr grafigi yo'q");
    expect(message.text).toContain("«Grafik yo'q» holatida");
  });

  function makeCron(prisma: any) {
    const telegram = { broadcastToHospital: jest.fn(async () => undefined) };
    const push = { sendToUser: jest.fn(async () => undefined) };
    const cron = new (CronService as any)(
      {},
      telegram,
      {},
      prisma,
      {},
      push,
      {},
      {},
      {},
      {},
    ) as CronService;
    return { cron, telegram, push };
  }

  function cronPrisma(): any {
    return {
      hospital: {
        findMany: jest.fn(async () => [
          { id: 'h1', name: 'Poliklinika', schedulePlanningMode: 'STANDARD' },
        ]),
      },
      employee: {
        findMany: jest.fn(async () => [
          { department: { name: 'Terapiya' }, schedules: [] },
        ]),
      },
      user: {
        findMany: jest.fn(async () => [{ id: 'admin' }, { id: 'director' }]),
      },
      hospitalAssistant: {
        findMany: jest.fn(async () => [{ userId: 'assistant' }]),
      },
      notification: { createMany: jest.fn(async () => ({ count: 3 })) },
    };
  }

  it('oy tugashiga 3 kun qolganda kadr inspektori, direktor va yordamchi adminga yuboradi', async () => {
    const prisma = cronPrisma();
    const { cron, telegram, push } = makeCron(prisma);

    await expect(
      cron.missingScheduleReminder(at('2026-10-29')),
    ).resolves.toEqual({ sent: 1 });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          hospitalId: 'h1',
          role: { in: ['ADMIN', 'DIRECTOR'] },
        }),
      }),
    );
    const data = prisma.notification.createMany.mock.calls[0][0].data;
    expect(data.map((row: any) => row.userId)).toEqual([
      'admin',
      'director',
      'assistant',
    ]);
    expect(data[0]).toMatchObject({
      type: 'ALERT',
      title: 'Noyabr oyi grafigi kiritilmagan',
      metadata: { kind: 'schedule-missing', year: 2026, month: 11 },
    });
    expect(push.sendToUser).toHaveBeenCalledTimes(3);
    expect(telegram.broadcastToHospital).toHaveBeenCalledWith(
      'h1',
      expect.stringContaining('Poliklinika'),
    );
  });

  it('boshqa kunlarda hech narsa yubormaydi', async () => {
    const prisma = cronPrisma();
    const { cron } = makeCron(prisma);
    await expect(
      cron.missingScheduleReminder(at('2026-10-20')),
    ).resolves.toEqual({ sent: 0 });
    await expect(
      cron.missingScheduleReminder(at('2026-10-31')),
    ).resolves.toEqual({ sent: 0 });
    expect(prisma.hospital.findMany).not.toHaveBeenCalled();
  });
});

describe('"Oldingi oydan nusxa olish" tugmasi', () => {
  it('post rejali muassasada ishlamaydi', async () => {
    const prisma: any = {
      hospital: {
        findUnique: jest.fn(async () => ({
          schedulePlanningMode: 'POST_COVERAGE',
        })),
      },
    };
    const svc = new SchedulesService(prisma);
    await expect(
      svc.rolloverMonth(10, 2026, 11, 2026, 'h2'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ta‘til ko‘chmaydi: o‘sha kun shu hafta kunining odatiy holati bilan to‘ldiriladi', async () => {
    // Oktabr 2026: 5-oktabr — dushanba (1-hafta, idx 0), 12-oktabr — 2-hafta.
    const created: any[] = [];
    const prisma: any = {
      hospital: {
        findUnique: jest.fn(async () => ({ schedulePlanningMode: 'STANDARD' })),
      },
      schedule: {
        findMany: jest
          .fn()
          // fromMonth da naqshi bor xodimlar
          .mockResolvedValueOnce([{ employeeId: 'e1' }])
          // toMonth da mavjud yozuvlar: faqat tasdiqlangan ta'til
          .mockResolvedValueOnce([{ employeeId: 'e1', ...LEAVE }])
          // fromMonth naqshi (ta'til kunlari so'rovda yo'q — faqat WORKING/DAY_OFF)
          .mockResolvedValueOnce([
            {
              employeeId: 'e1',
              date: day('2026-10-05'),
              shiftId: 's',
              status: 'WORKING',
            },
          ]),
        createMany: jest.fn(async ({ data }: any) => {
          created.push(...data);
          return { count: data.length };
        }),
      },
    };
    const svc = new SchedulesService(prisma);

    const result = await svc.rolloverMonth(10, 2026, 11, 2026, 'h1');

    // Ta'til yozuvi bor bo'lsa ham xodim o'tkazib yuborilmaydi
    expect(result.rolled).toBe(1);
    // So'rovlarda faqat ish/dam holatlari olinadi
    expect(prisma.schedule.findMany.mock.calls[0][0].where.status).toEqual({
      in: ['WORKING', 'DAY_OFF'],
    });
    expect(prisma.schedule.findMany.mock.calls[2][0].where.status).toEqual({
      in: ['WORKING', 'DAY_OFF'],
    });
    // Noyabrning barcha dushanbalari ish kuni (2-hafta naqshi yo'q edi — 1-haftadan olindi)
    const mondays = created
      .filter((row) => dayjs(row.date).tz('Asia/Tashkent').day() === 1)
      .map((row) => row.status);
    expect(mondays).toEqual([
      'WORKING',
      'WORKING',
      'WORKING',
      'WORKING',
      'WORKING',
    ]);
    expect(created.every((row) => row.status !== 'VACATION')).toBe(true);
    // Mavjud ta'til kunlari ustidan yozilmaydi
    expect(prisma.schedule.createMany.mock.calls[0][0].skipDuplicates).toBe(
      true,
    );
  });
});
