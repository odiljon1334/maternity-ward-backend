import { TerminalEventType } from '@prisma/client';
import { AttendanceService } from './attendance.service';

describe('AttendanceService fallback shift selection', () => {
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
});
