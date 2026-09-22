import { BadRequestException } from '@nestjs/common';
import { PayrollAdjustmentStatus, PayrollAdjustmentType } from '@prisma/client';
import { CompensationService } from './compensation.service';

describe('CompensationService legal workflow', () => {
  const employee = {
    id: 'emp-1',
    userId: 'employee-user',
    hospitalId: 'hospital-1',
    baseSalary: 5_000_000,
  };
  let stored: any;
  let prisma: any;
  let service: CompensationService;

  beforeEach(() => {
    stored = null;
    prisma = {
      employee: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === employee.id || where.userId === employee.userId
            ? employee
            : null,
        ),
      },
      payrollAdjustment: {
        create: jest.fn(async ({ data }: any) => {
          stored = { id: 'adj-1', ...data };
          return stored;
        }),
        findFirst: jest.fn(async () => stored),
        update: jest.fn(async ({ data }: any) => {
          stored = { ...stored, ...data };
          return stored;
        }),
      },
      attendanceRecord: { findMany: jest.fn(async () => []) },
      schedule: { findMany: jest.fn(async () => []) },
      notification: { create: jest.fn(async () => ({})) },
    };
    service = new CompensationService(prisma);
  });

  it('intizomiy jarimani avval tushuntirish bosqichida yaratadi', async () => {
    const result = await service.createAdjustment('director-1', 'hospital-1', {
      employeeId: employee.id,
      month: 9,
      year: 2026,
      type: PayrollAdjustmentType.DISCIPLINARY_FINE,
      proposedAmount: 300_000,
      reason: 'Tasdiqlangan intizom buzilishi',
    });

    expect(result.status).toBe(PayrollAdjustmentStatus.PENDING_EXPLANATION);
    expect(result.explanationRequestedAt).toBeInstanceOf(Date);
  });

  it('tushuntirish yoki bosh tortish dalolatnomasisiz jarimani tasdiqlamaydi', async () => {
    stored = {
      id: 'adj-1',
      type: PayrollAdjustmentType.DISCIPLINARY_FINE,
      status: PayrollAdjustmentStatus.PENDING_EXPLANATION,
      proposedAmount: 300_000,
      calculationBaseAmount: 5_000_000,
      employeeExplanation: null,
      evidence: null,
    };

    await expect(
      service.decideAdjustment('adj-1', 'director-1', 'hospital-1', {
        decision: 'APPROVED',
        decisionReason: 'Asoslandi',
        orderNumber: '12-A',
        orderDate: '2026-09-22',
        finePercent: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('buyruq tasdiqlangach xodim tanishmaguncha payrollga kiritmaydi', async () => {
    stored = {
      id: 'adj-1',
      type: PayrollAdjustmentType.DISCIPLINARY_FINE,
      status: PayrollAdjustmentStatus.PENDING_APPROVAL,
      proposedAmount: 300_000,
      calculationBaseAmount: 5_000_000,
      employeeExplanation: 'Tushuntirish matni',
      evidence: null,
    };

    const decided = await service.decideAdjustment(
      'adj-1',
      'director-1',
      'hospital-1',
      {
        decision: 'APPROVED',
        decisionReason: 'Dalillar ko‘rib chiqildi',
        orderNumber: '12-A',
        orderDate: '2026-09-22',
        finePercent: 30,
      },
    );
    expect(decided.status).toBe(
      PayrollAdjustmentStatus.PENDING_ACKNOWLEDGEMENT,
    );

    const acknowledged = await service.acknowledgeAdjustment(
      'adj-1',
      employee.userId,
    );
    expect(acknowledged.status).toBe(PayrollAdjustmentStatus.APPROVED);
    expect(acknowledged.acknowledgedAt).toBeInstanceOf(Date);
  });
});
