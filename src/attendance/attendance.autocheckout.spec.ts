import { AttendanceService } from './attendance.service';

describe('AttendanceService.autoCloseMissingCheckouts', () => {
  it('23:50 da yopilmagan kunduzgi davomatni grafik tugash vaqtida, overtimesiz yakunlaydi', async () => {
    const expectedCheckOut = new Date('2026-09-22T17:00:00+05:00');
    const record = {
      id: 'attendance-1',
      employeeId: 'employee-1',
      checkIn: new Date('2026-09-22T09:00:00+05:00'),
      checkOut: null,
      expectedCheckOut,
      lateMinutes: 0,
      status: 'PRESENT',
      lunchOut: null,
      lunchIn: null,
      employee: {
        id: 'employee-1',
        fullName: 'Test Xodim',
        hospitalId: 'hospital-1',
        userId: 'user-1',
        department: { name: 'Test bo‘lim' },
        position: { name: 'Test lavozim' },
        hospital: { id: 'hospital-1', name: 'Test muassasa' },
      },
      schedule: {
        shift: { lunchStart: '12:00', lunchEnd: '13:00' },
      },
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue([record]),
        updateMany,
      },
    };
    const locationGateway = {
      broadcastLocationRemoved: jest.fn(),
    };
    const service = new AttendanceService(
      prisma as any,
      {} as any,
      locationGateway as any,
      {} as any,
      {} as any,
    );

    const result = await service.autoCloseMissingCheckouts(
      new Date('2026-09-22T23:50:00+05:00'),
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'attendance-1', checkOut: null },
      data: expect.objectContaining({
        checkOut: expectedCheckOut,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 420,
        status: 'PRESENT',
        checkOutSource: 'AUTO',
        autoCheckOut: true,
      }),
    });
    expect(result).toEqual([
      expect.objectContaining({
        recordId: 'attendance-1',
        employeeName: 'Test Xodim',
        hospitalId: 'hospital-1',
        expectedCheckOut,
      }),
    ]);
    expect(locationGateway.broadcastLocationRemoved).toHaveBeenCalledWith(
      'hospital-1',
      'user-1',
    );
  });

  it('tungi smena hali tugamagan bo‘lsa 23:50 da avtomatik yopmaydi', async () => {
    const prisma = {
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
    };
    const service = new AttendanceService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const now = new Date('2026-09-22T23:50:00+05:00');
    const result = await service.autoCloseMissingCheckouts(now);

    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expectedCheckOut: expect.objectContaining({ lte: now }),
        }),
      }),
    );
    expect(result).toEqual([]);
    expect(prisma.attendanceRecord.updateMany).not.toHaveBeenCalled();
  });
});
