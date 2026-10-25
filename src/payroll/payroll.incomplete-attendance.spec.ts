import { PayrollService } from './payroll.service';

describe('Incomplete attendance payroll guard', () => {
  const record = {
    id: 'payroll-1',
    employeeId: 'employee-1',
    month: 10,
    year: 2026,
    status: 'DRAFT',
  };
  const attendance = {
    status: 'INCOMPLETE',
    checkIn: null,
    checkOut: new Date(),
    netWorkMin: 0,
  };
  it('does not calculate money from unknown arrival times', async () => {
    const prisma: any = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({ id: record.employeeId }),
      },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([attendance]) },
    };
    await expect(
      new PayrollService(prisma, {} as any).calculate(
        record.employeeId,
        10,
        2026,
      ),
    ).rejects.toThrow('kirish qaydi');
  });
  it('blocks approval of an old draft while a real scan still needs review', async () => {
    const update = jest.fn();
    const prisma: any = {
      payrollRecord: { findFirst: jest.fn().mockResolvedValue(record), update },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([attendance]) },
    };
    await expect(
      new PayrollService(prisma, {} as any).approve(record.id),
    ).rejects.toThrow('tekshirilmaguncha');
    expect(update).not.toHaveBeenCalled();
  });
});
