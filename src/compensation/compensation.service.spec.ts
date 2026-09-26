import { BadRequestException, ConflictException } from '@nestjs/common';
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

  describe('xodimning avans so‘rovi', () => {
    const period = () => {
      const d = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }),
      );
      return { month: d.getMonth() + 1, year: d.getFullYear() };
    };

    beforeEach(() => {
      prisma.salaryAdvance = {
        findMany: jest.fn(async () => []),
        create: jest.fn(async ({ data }: any) => ({ id: 'adv-1', ...data })),
        findFirst: jest.fn(),
        update: jest.fn(async ({ data }: any) => ({ id: 'adv-1', ...data })),
      };
    });

    it('joriy oy uchun qabul qilinadi', async () => {
      const res = await service.requestAdvance(
        employee.userId,
        true,
        undefined,
        {
          ...period(),
          amount: 1_000_000,
        },
      );
      expect(res.requestedAmount).toBe(1_000_000);
    });

    it('o‘tgan yoki uzoq oy uchun rad etiladi', async () => {
      const { year } = period();
      await expect(
        service.requestAdvance(employee.userId, true, undefined, {
          month: 1,
          year: year - 1,
          amount: 100_000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ko‘rib chiqilayotgan so‘rov bo‘lsa — ikkinchisi yaratilmaydi', async () => {
      prisma.salaryAdvance.findMany.mockResolvedValue([
        { status: 'REQUESTED', requestedAmount: 500_000 },
      ]);
      await expect(
        service.requestAdvance(employee.userId, true, undefined, {
          ...period(),
          amount: 100_000,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.salaryAdvance.create).not.toHaveBeenCalled();
    });

    it('oydagi avanslar jami bazaviy oylikdan oshmaydi', async () => {
      prisma.salaryAdvance.findMany.mockResolvedValue([
        { status: 'PAID', requestedAmount: 4_000_000, paidAmount: 4_000_000 },
      ]);
      await expect(
        service.requestAdvance(employee.userId, true, undefined, {
          ...period(),
          amount: 1_500_000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('faqat REQUESTED holatdagi so‘rov bekor qilinadi', async () => {
      prisma.salaryAdvance.findFirst.mockResolvedValue({
        id: 'adv-1',
        status: 'APPROVED',
      });
      await expect(
        service.cancelMyAdvance('adv-1', employee.userId),
      ).rejects.toBeInstanceOf(ConflictException);
      prisma.salaryAdvance.findFirst.mockResolvedValue({
        id: 'adv-1',
        status: 'REQUESTED',
      });
      await expect(
        service.cancelMyAdvance('adv-1', employee.userId),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
      });
    });
  });
});
