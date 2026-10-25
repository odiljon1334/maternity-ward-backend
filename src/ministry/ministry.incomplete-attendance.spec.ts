import { MinistryService } from './ministry.service';

it('does not label an unknown arrival as absence in ministry summaries', async () => {
  const p: any = {
    hospital: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'hospital-1', isActive: true, isBlocked: false },
        ]),
    },
    employee: {
      count: jest.fn().mockResolvedValue(1),
      aggregate: jest.fn().mockResolvedValue({ _sum: { baseSalary: 0 } }),
    },
    attendanceRecord: {
      count: jest.fn(async ({ where }: any) =>
        where.status === 'INCOMPLETE' ? 1 : 0,
      ),
    },
    schedule: { count: jest.fn().mockResolvedValue(1) },
    payrollRecord: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
  };
  const result = await new MinistryService(p).getOverview();
  expect(result.todayPresent).toBe(0);
  expect(result.todayAbsent).toBe(0);
  expect(result.todayIncomplete).toBe(1);
});
