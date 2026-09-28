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
});
