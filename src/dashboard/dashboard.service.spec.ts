import { DashboardService } from './dashboard.service';

describe('DashboardService excused lateness', () => {
  it('top late reytingida faqat uzrsiz daqiqalarni hisoblaydi', async () => {
    const prisma: any = {
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue([
          {
            employeeId: 'emp-1',
            lateMinutes: 30,
            excusedLateMin: 30,
          },
          {
            employeeId: 'emp-1',
            lateMinutes: 20,
            excusedLateMin: 5,
          },
          {
            employeeId: 'emp-2',
            lateMinutes: 10,
            excusedLateMin: 0,
          },
        ]),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'emp-1', fullName: 'A Xodim', department: { name: 'A' } },
          { id: 'emp-2', fullName: 'B Xodim', department: { name: 'B' } },
        ]),
      },
    };
    const service = new DashboardService(prisma);

    const result = await service.getTopLateEmployees(5, 'hospital-1');

    expect(result).toEqual([
      {
        employeeId: 'emp-1',
        name: 'A Xodim',
        department: 'A',
        lateCount: 1,
        totalLateMin: 15,
      },
      {
        employeeId: 'emp-2',
        name: 'B Xodim',
        department: 'B',
        lateCount: 1,
        totalLateMin: 10,
      },
    ]);
  });
  it('keeps an unknown arrival out of both present and absent totals', async () => {
    const prisma: any = {
      employee: { count: jest.fn().mockResolvedValue(1) },
      attendanceRecord: {
        count: jest.fn(async ({ where }: any) =>
          where.status === 'INCOMPLETE' ? 1 : 0,
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      payrollRecord: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { netSalary: 0 } }),
      },
      schedule: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const summary = await new DashboardService(prisma).getOverview();
    expect(summary.todayPresent).toBe(0);
    expect(summary.todayAbsent).toBe(0);
    expect(summary.todayIncomplete).toBe(1);
  });
});
