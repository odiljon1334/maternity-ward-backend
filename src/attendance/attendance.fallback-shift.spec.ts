import { TerminalEventType } from '@prisma/client';
import { AttendanceService } from './attendance.service';

describe('AttendanceService fallback shift selection', () => {
  // Terminal vaqti "hozir"ga nisbatan tekshiriladi — test sanasi eskirib
  // qolmasligi uchun soat event paytiga qo'yiladi
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-09-22T08:31:00+05:00'),
      advanceTimers: true,
    });
  });
  afterEach(() => jest.useRealTimers());

  it('08:30 kelganda 08:00 va 09:00 smenadan 09:00 ni tanlab, kechikish yozmaydi', async () => {
    const employee = {
      id: 'employee-1',
      employeeNo: '1001',
      fullName: 'Test Xodim',
      hospitalId: 'hospital-1',
      userId: null,
      hospital: { id: 'hospital-1', name: 'Test' },
      department: { name: 'Test' },
      position: { name: 'Test' },
    };
    const createAttendance = jest.fn(async ({ data }) => ({
      id: 'attendance-1',
      ...data,
    }));
    const prisma = {
      employee: { findUnique: jest.fn().mockResolvedValue(employee) },
      hospital: {
        findUnique: jest.fn().mockResolvedValue({ isBlocked: false }),
      },
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
      schedule: { findUnique: jest.fn().mockResolvedValue(null) },
      shiftTemplate: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'shift-08',
            startTime: '08:00',
            endTime: '17:00',
            graceMinutes: 15,
            isOvernight: false,
          },
          {
            id: 'shift-09',
            startTime: '09:00',
            endTime: '18:00',
            graceMinutes: 15,
            isOvernight: false,
          },
        ]),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: createAttendance,
      },
      attendanceEvent: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      weeklyAttendanceStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new AttendanceService(
      prisma as any,
      {} as any,
      { broadcastAttendance: jest.fn() } as any,
      {} as any,
      {} as any,
    );

    const result = await service.processHikvisionEvent({
      employeeNo: '1001',
      eventTime: '2026-09-22T08:30:00+05:00',
      terminalEventType: TerminalEventType.CHECK_IN,
    });

    expect(result?.attendance.status).toBe('PRESENT');
    expect(result?.attendance.lateMinutes).toBe(0);
    expect(result?.attendance.expectedCheckIn).toEqual(
      new Date('2026-09-22T09:00:00+05:00'),
    );
    expect(result?.attendance.checkIn).toEqual(
      new Date('2026-09-22T08:30:00+05:00'),
    );
  });

  it("grafik yo'q bo'lsa terminal CHECK_OUT yuborsa ham birinchi yuz skanini CHECK_IN qiladi", async () => {
    const employee = {
      id: 'employee-1',
      employeeNo: '1001',
      fullName: 'Test Xodim',
      hospitalId: 'hospital-1',
      userId: null,
      hospital: { id: 'hospital-1', name: 'Test' },
      department: { name: 'Test' },
      position: { name: 'Test' },
    };
    const createAttendance = jest.fn(async ({ data }) => ({
      id: 'attendance-1',
      ...data,
    }));
    const prisma = {
      employee: { findUnique: jest.fn().mockResolvedValue(employee) },
      hospital: {
        findUnique: jest.fn().mockResolvedValue({ isBlocked: false }),
      },
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
      schedule: { findUnique: jest.fn().mockResolvedValue(null) },
      shiftTemplate: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'shift-09',
            startTime: '09:00',
            endTime: '18:00',
            graceMinutes: 15,
            isOvernight: false,
          },
        ]),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: createAttendance,
      },
      attendanceEvent: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      weeklyAttendanceStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new AttendanceService(
      prisma as any,
      {} as any,
      { broadcastAttendance: jest.fn() } as any,
      {} as any,
      {} as any,
    );

    const result = await service.processHikvisionEvent({
      employeeNo: '1001',
      eventTime: '2026-09-22T08:30:00+05:00',
      terminalEventType: TerminalEventType.CHECK_OUT,
    });

    expect(result?.action).toBe(TerminalEventType.CHECK_IN);
    expect(createAttendance).toHaveBeenCalledTimes(1);
  });

  it("grafik yo'q bo'lsa terminal doim CHECK_IN yuborsa ham keyingi uzoq skanni CHECK_OUT qiladi", async () => {
    jest.setSystemTime(new Date('2026-09-22T17:01:00+05:00'));
    const checkIn = new Date('2026-09-22T08:30:00+05:00');
    const existing = {
      id: 'attendance-1',
      employeeId: 'employee-1',
      workDate: new Date('2026-09-22T00:00:00+05:00'),
      checkIn,
      checkOut: null,
      expectedCheckIn: new Date('2026-09-22T09:00:00+05:00'),
      expectedCheckOut: new Date('2026-09-22T18:00:00+05:00'),
      lateMinutes: 0,
      status: 'PRESENT',
      lunchOut: null,
      lunchIn: null,
    };
    const employee = {
      id: 'employee-1',
      employeeNo: '1001',
      fullName: 'Test Xodim',
      hospitalId: 'hospital-1',
      userId: null,
      hospital: { id: 'hospital-1', name: 'Test' },
      department: { name: 'Test' },
      position: { name: 'Test' },
    };
    const updateAttendance = jest.fn(async ({ data }) => ({
      ...existing,
      ...data,
    }));
    const prisma = {
      employee: { findUnique: jest.fn().mockResolvedValue(employee) },
      hospital: {
        findUnique: jest.fn().mockResolvedValue({ isBlocked: false }),
      },
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
      schedule: { findUnique: jest.fn().mockResolvedValue(null) },
      shiftTemplate: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'shift-09',
            startTime: '09:00',
            endTime: '18:00',
            graceMinutes: 15,
            isOvernight: false,
          },
        ]),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: updateAttendance,
      },
      attendanceEvent: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      weeklyAttendanceStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new AttendanceService(
      prisma as any,
      {} as any,
      { broadcastAttendance: jest.fn(), broadcastLocationRemoved: jest.fn() } as any,
      {} as any,
      {} as any,
    );

    const result = await service.processHikvisionEvent({
      employeeNo: '1001',
      eventTime: '2026-09-22T17:00:00+05:00',
      terminalEventType: TerminalEventType.CHECK_IN,
    });

    expect(result?.action).toBe(TerminalEventType.CHECK_OUT);
    expect(updateAttendance).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checkOut: new Date('2026-09-22T17:00:00+05:00'),
          checkOutSource: 'TERMINAL',
        }),
      }),
    );
  });

  it("ta'til kuni terminal skanini auditga yozadi, lekin PRESENT qilmaydi", async () => {
    const createAttendance = jest.fn();
    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'employee-1',
          employeeNo: '1001',
          fullName: 'Test Xodim',
          hospitalId: 'hospital-1',
          userId: null,
          hospital: { id: 'hospital-1', name: 'Test' },
          department: { name: 'Test' },
          position: { name: 'Test' },
        }),
      },
      hospital: {
        findUnique: jest.fn().mockResolvedValue({ isBlocked: false }),
      },
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
      schedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'schedule-1',
          status: 'VACATION',
          shift: null,
        }),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: createAttendance,
      },
      attendanceEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new AttendanceService(
      prisma as any,
      {} as any,
      { broadcastAttendance: jest.fn() } as any,
      {} as any,
      {} as any,
    );

    const result = await service.processHikvisionEvent({
      employeeNo: '1001',
      eventTime: '2026-09-22T08:30:00+05:00',
      terminalEventType: TerminalEventType.CHECK_IN,
    });

    expect(result).toBeNull();
    expect(createAttendance).not.toHaveBeenCalled();
    expect(prisma.attendanceEvent.create).toHaveBeenCalledTimes(1);
  });
});
