import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { AttendanceService } from './attendance.service';
import {
  checkInDeadline,
  isAwaitingCheckIn,
} from '../common/utils/shift-timing.util';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'Asia/Tashkent';

/** Toshkent vaqti bo'yicha aniq lahza */
const at = (date: string, time: string) =>
  dayjs.tz(`${date} ${time}`, TZ).toDate();
const day = (date: string) => dayjs.tz(date, TZ).startOf('day').toDate();

const NIGHT = {
  startTime: '20:00',
  endTime: '08:00',
  isOvernight: true,
  graceMinutes: 15,
};
const DAY = {
  startTime: '08:00',
  endTime: '20:00',
  isOvernight: false,
  graceMinutes: 15,
};

describe('Smenasi hali boshlanmagan xodim "Kelmadi" emas', () => {
  afterEach(() => jest.useRealTimers());

  it('kechikishga ruxsat tugagunicha "Rejada"', () => {
    const workDate = day('2026-10-17');
    expect(checkInDeadline(workDate, NIGHT)).toEqual(at('2026-10-17', '20:15'));
    expect(isAwaitingCheckIn(workDate, NIGHT, at('2026-10-17', '16:00'))).toBe(
      true,
    );
    expect(isAwaitingCheckIn(workDate, NIGHT, at('2026-10-17', '20:14'))).toBe(
      true,
    );
    expect(isAwaitingCheckIn(workDate, NIGHT, at('2026-10-17', '20:16'))).toBe(
      false,
    );
  });

  function setup(schedules: any[], records: any[] = []) {
    const prisma: any = {
      attendanceRecord: {
        findMany: jest.fn(async () => records),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      },
      schedule: { findMany: jest.fn(async () => schedules) },
      employee: { findMany: jest.fn(async () => []) },
    };
    const service = new AttendanceService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
    );
    return { prisma, service };
  }

  const employee = (id: string) => ({ id, fullName: `Xodim ${id}` });

  it('kunlik davomat: soat 16:00 da kechki smena — Rejada, kunduzgi — Kelmadi', async () => {
    jest.useFakeTimers({ now: at('2026-10-17', '16:00') });
    const { service } = setup([
      {
        id: 's1',
        employeeId: 'night',
        status: 'WORKING',
        shift: NIGHT,
        employee: employee('night'),
      },
      {
        id: 's2',
        employeeId: 'day',
        status: 'WORKING',
        shift: DAY,
        employee: employee('day'),
      },
      {
        id: 's3',
        employeeId: 'off',
        status: 'DAY_OFF',
        shift: null,
        employee: employee('off'),
      },
    ]);

    const rows = await service.getDailyAttendance('2026-10-17');
    const status = Object.fromEntries(
      rows.map((r: any) => [r.employeeId, r.status]),
    );

    expect(status).toEqual({
      night: 'SCHEDULED',
      day: 'ABSENT',
      off: 'DAY_OFF',
    });
  });

  it('21:00 dagi cron: 22:00 dagi smena oldindan "Kelmadi" bo‘lmaydi', async () => {
    jest.useFakeTimers({ now: at('2026-10-16', '21:00') }); // juma
    const late = {
      startTime: '22:00',
      endTime: '06:00',
      isOvernight: true,
      graceMinutes: 15,
    };
    const today = day('2026-10-16');
    const { prisma, service } = setup([]);
    prisma.schedule.findMany.mockImplementation(async ({ where }: any) =>
      where.date.getTime() === today.getTime()
        ? [
            { id: 'a', employeeId: 'night', shiftId: 'n', shift: NIGHT },
            { id: 'b', employeeId: 'late', shiftId: 'l', shift: late },
            { id: 'c', employeeId: 'day', shiftId: 'd', shift: DAY },
          ]
        : [],
    );

    const result = await service.markAbsentForToday();

    const created = prisma.attendanceRecord.createMany.mock.calls.flatMap(
      ([arg]: any) => arg.data.map((row: any) => row.employeeId),
    );
    expect(created.sort()).toEqual(['day', 'night']);
    expect(result).toEqual({ marked: 2, skipped: false });
  });

  it('ertangi ishga tushishda kechagi kech smena kelmagan bo‘lsa belgilanadi', async () => {
    jest.useFakeTimers({ now: at('2026-10-16', '21:00') }); // juma, kecha — payshanba
    const late = {
      startTime: '22:00',
      endTime: '06:00',
      isOvernight: true,
      graceMinutes: 15,
    };
    const yesterday = day('2026-10-15');
    const { prisma, service } = setup([]);
    prisma.schedule.findMany.mockImplementation(async ({ where }: any) =>
      where.date.getTime() === yesterday.getTime()
        ? [{ id: 'b', employeeId: 'late', shiftId: 'l', shift: late }]
        : [],
    );

    await service.markAbsentForToday();

    expect(prisma.attendanceRecord.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          employeeId: 'late',
          workDate: yesterday,
          status: 'ABSENT',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('shanba: grafikda ish kuni bo‘lib kelmagan xodim "Kelmadi", grafiksiz — hech narsa', async () => {
    jest.useFakeTimers({ now: at('2026-10-17', '21:00') }); // shanba
    const saturday = day('2026-10-17');
    const { prisma, service } = setup([]);
    prisma.schedule.findMany.mockImplementation(async ({ where }: any) =>
      where.date.getTime() === saturday.getTime()
        ? [{ id: 'w', employeeId: 'weekend-shift', shiftId: 'd', shift: DAY }]
        : [],
    );

    const result = await service.markAbsentForToday();

    expect(result).toEqual({ marked: 1, skipped: false });
    expect(prisma.attendanceRecord.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          employeeId: 'weekend-shift',
          workDate: saturday,
          status: 'ABSENT',
        }),
      ],
      skipDuplicates: true,
    });
    // Faqat grafigi WORKING bo'lganlar so'raladi — grafiksiz xodimga yozuv yo'q
    expect(prisma.schedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'WORKING' }),
      }),
    );
  });
});

describe('Bo‘sh smena smena boshlangandan keyin berilgan bo‘lsa', () => {
  afterEach(() => jest.useRealTimers());
  const workDate = day('2026-10-20');
  const lateStart = at('2026-10-20', '11:00');

  it('"Kelmadi" muddati va kutilgan vaqt — grafikdagi kech kelish vaqtidan', () => {
    expect(checkInDeadline(workDate, DAY, lateStart)).toEqual(
      at('2026-10-20', '11:15'),
    );
    expect(
      isAwaitingCheckIn(workDate, DAY, at('2026-10-20', '10:30'), lateStart),
    ).toBe(true);
    expect(isAwaitingCheckIn(workDate, DAY, at('2026-10-20', '10:30'))).toBe(
      false,
    );
  });

  it('11:00 da kelish kerak bo‘lgan o‘rinbosar 10:30 da "Kelmadi" emas, "Rejada"', async () => {
    jest.useFakeTimers({ now: at('2026-10-20', '10:30') });
    const prisma: any = {
      attendanceRecord: { findMany: jest.fn(async () => []) },
      schedule: {
        findMany: jest.fn(async () => [
          {
            id: 's1',
            employeeId: 'sub',
            status: 'WORKING',
            shift: DAY,
            expectedStartAt: lateStart,
            employee: { id: 'sub', fullName: 'O‘rinbosar' },
          },
        ]),
      },
      employee: { findMany: jest.fn(async () => []) },
    };
    const service = new AttendanceService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
    );
    const [row] = await service.getDailyAttendance('2026-10-20');
    expect(row.status).toBe('SCHEDULED');
    expect(row.expectedCheckIn).toEqual(lateStart);
  });
});
