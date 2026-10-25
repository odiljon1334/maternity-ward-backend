import { AttendanceService } from './attendance.service';
import { TerminalEventType } from '@prisma/client';

function setup(initial: any = null) {
  let record = initial;
  const shift = {
    startTime: '08:00',
    endTime: '17:00',
    graceMinutes: 15,
    isOvernight: false,
  };
  const schedule = { id: 'schedule-1', status: 'WORKING', shift };
  const prisma: any = {
    employee: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'employee-1',
        employeeNo: '1',
        fullName: 'Test',
        hospitalId: 'hospital-1',
      }),
    },
    hospital: { findUnique: jest.fn().mockResolvedValue({ isBlocked: false }) },
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    schedule: { findUnique: jest.fn().mockResolvedValue(schedule) },
    attendanceEvent: { create: jest.fn(), updateMany: jest.fn() },
    attendanceRecord: {
      findFirst: jest.fn(async () => record),
      createMany: jest.fn(async ({ data }) => {
        if (!record) record = { id: 'record-1', ...data };
        return { count: 1 };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (
          record &&
          !record.checkIn &&
          !record.checkOut &&
          where.checkIn === null
        ) {
          record = { ...record, ...data };
          return { count: 1 };
        }
        return { count: 0 };
      }),
      update: jest.fn(async ({ data }) => (record = { ...record, ...data })),
    },
  };
  const service = new AttendanceService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest.spyOn(service as any, 'findTodaySchedule').mockResolvedValue(schedule);
  jest.spyOn(service as any, 'updateWeeklyStats').mockResolvedValue(undefined);
  jest
    .spyOn(service as any, 'emitAttendanceEvent')
    .mockImplementation(() => {});
  const scan = (
    time = '17:03:00',
    type: TerminalEventType = TerminalEventType.CHECK_OUT,
  ) =>
    service.processHikvisionEvent({
      employeeNo: '1',
      eventTime: `2026-10-25T${time}+05:00`,
      terminalEventType: type,
    });
  return { prisma, service, scan, record: () => record };
}

describe('Terminal CHECK_OUT without a check-in', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-10-25T18:00:00+05:00') }),
  );
  afterEach(() => jest.useRealTimers());

  it('keeps the actual exit and marks a new day incomplete without inventing an arrival', async () => {
    const f = setup();
    await f.scan();
    expect(f.record()).toMatchObject({
      status: 'INCOMPLETE',
      checkIn: null,
      checkOut: new Date('2026-10-25T17:03:00+05:00'),
      rawCheckOutTime: new Date('2026-10-25T17:03:00+05:00'),
      netWorkMin: 0,
      lateMinutes: 0,
      earlyLeaveMin: 0,
      overtimeMinutes: 0,
    });
    expect(f.prisma.attendanceEvent.updateMany).toHaveBeenCalled();
  });

  it('repairs an existing absence using the actual exit and leaves arrival unknown', async () => {
    const f = setup({
      id: 'record-1',
      status: 'ABSENT',
      checkIn: null,
      checkOut: null,
    });
    await f.scan();
    expect(f.record()).toMatchObject({
      status: 'INCOMPLETE',
      checkIn: null,
      checkOut: new Date('2026-10-25T17:03:00+05:00'),
    });
  });

  it('does not overwrite a first exit on duplicate CHECK_OUT scans', async () => {
    const f = setup();
    await f.scan();
    await f.scan('17:04:00');
    expect(f.record()?.checkOut).toEqual(new Date('2026-10-25T17:03:00+05:00'));
    expect(f.record()?.status).toBe('INCOMPLETE');
  });

  it('resolves an incomplete day only when a real earlier check-in arrives', async () => {
    const f = setup({
      id: 'record-1',
      status: 'INCOMPLETE',
      checkIn: null,
      checkOut: new Date('2026-10-25T17:00:00+05:00'),
      expectedCheckIn: new Date('2026-10-25T08:00:00+05:00'),
      expectedCheckOut: new Date('2026-10-25T17:00:00+05:00'),
    });
    await f.scan('08:00:00', TerminalEventType.CHECK_IN);
    expect(f.record()).toMatchObject({
      status: 'PRESENT',
      checkIn: new Date('2026-10-25T08:00:00+05:00'),
      netWorkMin: 540,
    });
  });
  it('assigns a morning exit to yesterday overnight shift even when today has a schedule, replacing only AUTO exit', async () => {
    const yesterday = new Date('2026-10-24T00:00:00+05:00');
    const f = setup({
      id: 'record-1',
      status: 'PRESENT',
      checkIn: new Date('2026-10-24T20:00:00+05:00'),
      checkOut: new Date('2026-10-25T08:00:00+05:00'),
      autoCheckOut: true,
      expectedCheckOut: new Date('2026-10-25T08:00:00+05:00'),
      lateMinutes: 0,
    });
    f.prisma.schedule.findUnique.mockImplementation(async ({ where }: any) => ({
      id: 'night-schedule',
      date: where.employeeId_date.date,
      status: 'WORKING',
      shift: { startTime: '20:00', endTime: '08:00', isOvernight: true },
    }));
    await f.scan('08:05:00');
    expect(f.prisma.attendanceRecord.findFirst).toHaveBeenCalledWith({
      where: { employeeId: 'employee-1', workDate: yesterday },
    });
    expect(f.record()).toMatchObject({
      checkIn: new Date('2026-10-24T20:00:00+05:00'),
      checkOut: new Date('2026-10-25T08:05:00+05:00'),
      autoCheckOut: false,
    });
  });

  it('refuses a check-in later than an already known exit', async () => {
    const f = setup({
      id: 'record-1',
      status: 'INCOMPLETE',
      checkIn: null,
      checkOut: new Date('2026-10-25T07:00:00+05:00'),
      expectedCheckIn: new Date('2026-10-25T08:00:00+05:00'),
    });
    await expect(
      f.scan('08:00:00', TerminalEventType.CHECK_IN),
    ).rejects.toThrow('chiqishdan keyin');
    expect(f.prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });
});
