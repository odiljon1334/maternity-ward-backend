import { SchedulePlanningMode } from '@prisma/client';
import { OperationalCenterService } from './operational-center.service';
import { DateUtil } from '../common/utils/date.util';

describe('OperationalCenterService', () => {
  const basePrisma = () => ({
    hospital: { findFirst: jest.fn() },
    schedule: { findMany: jest.fn().mockResolvedValue([]) },
    shiftSwapRequest: { findMany: jest.fn().mockResolvedValue([]) },
    employee: { findMany: jest.fn().mockResolvedValue([]) },
    schedulePost: { findMany: jest.fn().mockResolvedValue([]) },
    monthlySchedulePlan: { findMany: jest.fn().mockResolvedValue([]) },
    attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it('kechikkan check-inni kritik xavf sifatida va tenant ichida qaytaradi', async () => {
    const prisma = basePrisma();
    prisma.hospital.findFirst.mockResolvedValue({
      id: 'hospital-1',
      name: 'Test muassasa',
      schedulePlanningMode: SchedulePlanningMode.STANDARD,
    });
    prisma.schedule.findMany.mockResolvedValue([
      {
        id: 'schedule-1',
        employeeId: 'employee-1',
        shift: {
          startTime: '00:00',
          endTime: '08:00',
          graceMinutes: 0,
          isOvernight: false,
        },
        attendance: null,
        employee: {
          id: 'employee-1',
          fullName: 'Test Xodim',
          departmentId: 'department-1',
          positionId: 'position-1',
          department: { name: 'Qabulxona' },
          position: { name: 'Hamshira' },
        },
      },
    ]);

    const service = new OperationalCenterService(
      prisma as any,
      { getPlanDetails: jest.fn() } as any,
    );
    const result = await service.getOverview('hospital-1');

    expect(prisma.schedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          employee: expect.objectContaining({ hospitalId: 'hospital-1' }),
        }),
      }),
    );
    expect(result.modes.STANDARD.items[0]).toEqual(
      expect.objectContaining({
        level: 'CRITICAL',
        kind: 'MISSING_CHECKIN',
        employeeId: 'employee-1',
      }),
    );
    expect(result.modes.POST_COVERAGE.enabled).toBe(false);
  });

  it('eski GPS signalini ogohlantiradi, lekin xodim ketgan deb xulosa qilmaydi', async () => {
    const prisma = basePrisma();
    prisma.hospital.findFirst.mockResolvedValue({
      id: 'hospital-1',
      name: 'Test muassasa',
      schedulePlanningMode: SchedulePlanningMode.STANDARD,
    });
    prisma.attendanceRecord.findMany.mockResolvedValue([
      {
        id: 'attendance-1',
        employeeId: 'employee-1',
        checkIn: DateUtil.now().subtract(2, 'hour').toDate(),
        checkInSource: 'MOBILE',
        employee: {
          id: 'employee-1',
          fullName: 'GPS Xodim',
          department: { name: 'Sayyor xizmat' },
          position: { name: 'Hamshira' },
          user: {
            liveLocations: [
              {
                createdAt: DateUtil.now().subtract(40, 'minute').toDate(),
                isOutside: false,
                accuracy: 12,
              },
            ],
          },
        },
      },
    ]);

    const service = new OperationalCenterService(
      prisma as any,
      { getPlanDetails: jest.fn() } as any,
    );
    const result = await service.getOverview('hospital-1');
    const item = result.modes.FLEXIBLE.items[0];

    expect(item.kind).toBe('STALE_LOCATION');
    expect(item.description).toContain('xodim ketganini tasdiqlamaydi');
    expect(item.level).toBe('WARNING');
  });

  it('terminal check-in uchun GPS tarixisiz noto‘g‘ri ogohlantirish yaratmaydi', async () => {
    const prisma = basePrisma();
    prisma.hospital.findFirst.mockResolvedValue({
      id: 'hospital-1',
      name: 'Test muassasa',
      schedulePlanningMode: SchedulePlanningMode.STANDARD,
    });
    prisma.attendanceRecord.findMany.mockResolvedValue([
      {
        id: 'attendance-1',
        employeeId: 'employee-1',
        checkIn: DateUtil.now().subtract(1, 'hour').toDate(),
        checkInSource: 'TERMINAL',
        employee: {
          id: 'employee-1',
          fullName: 'Terminal Xodim',
          department: { name: 'Qabulxona' },
          position: { name: 'Registrator' },
          user: { liveLocations: [] },
        },
      },
    ]);

    const service = new OperationalCenterService(
      prisma as any,
      { getPlanDetails: jest.fn() } as any,
    );
    const result = await service.getOverview('hospital-1');

    expect(result.modes.FLEXIBLE.items).toEqual([]);
    expect(result.modes.FLEXIBLE.metrics.monitored).toBe(0);
  });
});
