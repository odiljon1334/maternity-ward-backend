import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import {
  PayrollAdjustmentStatus,
  PayrollAdjustmentType,
  SalaryAdvanceStatus,
} from '@prisma/client';

/**
 * PayrollService.calculate() uchun servis-darajasidagi (unit) testlar —
 * Faza 3.4 ("payroll hisoblash" qismi).
 *
 * HAQIQIY bazasiz ishlaydi (auth.service.spec.ts'dagi kabi PrismaService
 * xotiradagi soxta ma'lumotlar bilan almashtiriladi). Maqsad: maosh
 * hisoblash formulasi (kelmagan kunlar uchun ushlab qolish, kechikish
 * jarimasi, erta ketish, overtime bonusi, netSalary >= 0 chegarasi) haqiqiy
 * kod bo'yicha to'g'ri ishlashini tekshirish — bu to'g'ridan-to'g'ri
 * xodimlarning ish haqqiga ta'sir qiladigan eng muhim biznes mantiq.
 */

function makeFakePrisma() {
  const employees: any[] = [];
  const attendanceRecords: any[] = [];
  const weeklyStats: any[] = [];
  const schedules: any[] = [];
  const adjustments: any[] = [];
  const advances: any[] = [];

  return {
    __state: {
      employees,
      attendanceRecords,
      weeklyStats,
      schedules,
      adjustments,
      advances,
    },

    employee: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          employees.find((e) => e.id === where.id) ?? null,
      ),
    },

    attendanceRecord: {
      findMany: jest.fn(async ({ where }: any) =>
        attendanceRecords.filter((r) => r.employeeId === where.employeeId),
      ),
    },

    weeklyAttendanceStat: {
      findMany: jest.fn(async ({ where }: any) =>
        weeklyStats.filter((w) => w.employeeId === where.employeeId),
      ),
    },

    schedule: {
      findMany: jest.fn(async ({ where }: any) =>
        schedules.filter(
          (s) => s.employeeId === where.employeeId && s.status === 'WORKING',
        ),
      ),
    },

    payrollAdjustment: {
      findMany: jest.fn(async ({ where }: any) =>
        adjustments.filter(
          (item) =>
            item.employeeId === where.employeeId &&
            item.month === where.month &&
            item.year === where.year &&
            where.status.in.includes(item.status),
        ),
      ),
    },

    salaryAdvance: {
      findMany: jest.fn(async ({ where }: any) =>
        advances.filter(
          (item) =>
            item.employeeId === where.employeeId &&
            item.month === where.month &&
            item.year === where.year &&
            where.status.in.includes(item.status),
        ),
      ),
    },
  };
}

describe('PayrollService', () => {
  let service: PayrollService;
  let prisma: ReturnType<typeof makeFakePrisma>;

  const EMPLOYEE_ID = 'emp-1';
  const MONTH = 3;
  const YEAR = 2026;
  // 22 ish kuni jadval bo'yicha, 12 soatlik (720 daqiqa) smena
  const SCHEDULED_DAYS = 22;
  const BASE_SALARY = 5_500_000;

  function seedSchedule(days: number) {
    for (let i = 0; i < days; i++) {
      prisma.__state.schedules.push({
        employeeId: EMPLOYEE_ID,
        status: 'WORKING',
        shift: {
          startTime: '08:00',
          endTime: '20:00',
          isOvernight: false,
          lunchStart: null,
          lunchEnd: null,
        },
      });
    }
  }

  beforeEach(async () => {
    prisma = makeFakePrisma();
    prisma.__state.employees.push({
      id: EMPLOYEE_ID,
      baseSalary: BASE_SALARY,
    });
    seedSchedule(SCHEDULED_DAYS);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollService,
        { provide: PrismaService, useValue: prisma },
        { provide: PushService, useValue: { send: jest.fn() } },
      ],
    }).compile();

    service = module.get(PayrollService);
  });

  it("mavjud bo'lmagan xodimda NotFoundException tashlaydi", async () => {
    await expect(
      service.calculate('no-such-employee', MONTH, YEAR),
    ).rejects.toThrow(NotFoundException);
  });

  it("kelmagan kunlar, kechikish va overtime bo'lmasa netSalary === baseSalary bo'ladi", async () => {
    // Barcha 22 kun to'liq ishlangan, muammosiz
    for (let i = 0; i < SCHEDULED_DAYS; i++) {
      prisma.__state.attendanceRecords.push({
        employeeId: EMPLOYEE_ID,
        status: 'PRESENT',
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 720,
      });
    }

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.scheduledDays).toBe(SCHEDULED_DAYS);
    expect(preview.totalWorkDays).toBe(SCHEDULED_DAYS);
    expect(preview.totalAbsences).toBe(0);
    expect(preview.absenceDeduction).toBe(0);
    expect(preview.lateDeduction).toBe(0);
    expect(preview.overtimeBonus).toBe(0);
    expect(preview.netSalary).toBe(BASE_SALARY);
  });

  it('kelmagan har bir kun uchun kunlik stavka (baseSalary / scheduledDays) ushlab qolinadi', async () => {
    const ABSENCES = 3;
    for (let i = 0; i < SCHEDULED_DAYS - ABSENCES; i++) {
      prisma.__state.attendanceRecords.push({
        employeeId: EMPLOYEE_ID,
        status: 'PRESENT',
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 720,
      });
    }
    for (let i = 0; i < ABSENCES; i++) {
      prisma.__state.attendanceRecords.push({
        employeeId: EMPLOYEE_ID,
        status: 'ABSENT',
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 0,
      });
    }

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    const dailyRate = BASE_SALARY / SCHEDULED_DAYS;
    const expectedDeduction = Math.round(ABSENCES * dailyRate);

    expect(preview.totalAbsences).toBe(ABSENCES);
    expect(preview.absenceDeduction).toBe(expectedDeduction);
    expect(preview.netSalary).toBe(Math.round(BASE_SALARY - expectedDeduction));
  });

  it('o‘tgan WORKING grafikda davomat yozuvi bo‘lmasa ham kelmagan kunni hisoblaydi', async () => {
    prisma.__state.schedules.length = 0;
    const shift = {
      startTime: '09:00',
      endTime: '18:00',
      isOvernight: false,
      lunchStart: '12:00',
      lunchEnd: '13:00',
    };
    prisma.__state.schedules.push(
      {
        id: 'schedule-1',
        employeeId: EMPLOYEE_ID,
        status: 'WORKING',
        date: new Date('2026-03-02T00:00:00+05:00'),
        shift,
      },
      {
        id: 'schedule-2',
        employeeId: EMPLOYEE_ID,
        status: 'WORKING',
        date: new Date('2026-03-03T00:00:00+05:00'),
        shift,
      },
    );
    prisma.__state.attendanceRecords.push({
      employeeId: EMPLOYEE_ID,
      scheduleId: 'schedule-1',
      workDate: new Date('2026-03-02T00:00:00+05:00'),
      status: 'PRESENT',
      lateMinutes: 0,
      earlyLeaveMin: 0,
      overtimeMinutes: 0,
      netWorkMin: 480,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.scheduledDays).toBe(2);
    expect(preview.totalWorkDays).toBe(1);
    expect(preview.totalAbsences).toBe(1);
    expect(preview.absenceDeduction).toBe(Math.round(BASE_SALARY / 2));
  });

  it('kechikishni qayd etadi, lekin avtomatik pul jarimasi hisoblamaydi', async () => {
    prisma.__state.attendanceRecords.push(
      {
        employeeId: EMPLOYEE_ID,
        workDate: new Date('2026-03-02T09:00:00+05:00'),
        status: 'LATE',
        lateMinutes: 70,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 650,
      },
      {
        employeeId: EMPLOYEE_ID,
        workDate: new Date('2026-03-03T09:00:00+05:00'),
        status: 'LATE',
        lateMinutes: 60,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 660,
      },
    );
    // Bu jamlanma ataylab noto'g'ri/eski: calculate uni ishlatmasligi kerak.
    prisma.__state.weeklyStats.push({
      employeeId: EMPLOYEE_ID,
      deductionAmount: 65_000,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.totalLateMin).toBe(130);
    expect(preview.lateDeduction).toBe(0);
    expect(preview.netSalary).toBe(BASE_SALARY);
  });

  it('aniqlangan overtime tasdiqsiz bo‘lsa pul qo‘shmaydi', async () => {
    const OVERTIME_MIN = 120; // 2 soat overtime
    prisma.__state.attendanceRecords.push({
      employeeId: EMPLOYEE_ID,
      status: 'PRESENT',
      lateMinutes: 0,
      earlyLeaveMin: 0,
      overtimeMinutes: OVERTIME_MIN,
      netWorkMin: 720,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.totalOvertimeMin).toBe(OVERTIME_MIN);
    expect(preview.overtimeBonus).toBe(0);
    expect(preview.netSalary).toBe(BASE_SALARY);
  });

  it('faqat tasdiqlangan KPI va to‘langan avansni yakuniy hisobga qo‘shadi', async () => {
    prisma.__state.adjustments.push(
      {
        employeeId: EMPLOYEE_ID,
        month: MONTH,
        year: YEAR,
        status: PayrollAdjustmentStatus.APPROVED,
        type: PayrollAdjustmentType.CONTRACTUAL_KPI_BONUS,
        proposedAmount: 400_000,
        approvedAmount: 350_000,
      },
      {
        employeeId: EMPLOYEE_ID,
        month: MONTH,
        year: YEAR,
        status: PayrollAdjustmentStatus.PENDING_APPROVAL,
        type: PayrollAdjustmentType.ONE_TIME_AWARD,
        proposedAmount: 900_000,
      },
    );
    prisma.__state.advances.push({
      employeeId: EMPLOYEE_ID,
      month: MONTH,
      year: YEAR,
      status: SalaryAdvanceStatus.PAID,
      approvedAmount: 1_000_000,
      paidAmount: 800_000,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.contractualKpiBonus).toBe(350_000);
    expect(preview.oneTimeAward).toBe(0);
    expect(preview.advancePaid).toBe(800_000);
    expect(preview.advanceApplied).toBe(800_000);
    expect(preview.deferredAdvance).toBe(0);
    expect(preview.grossSalary).toBe(BASE_SALARY + 350_000);
    expect(preview.netSalary).toBe(BASE_SALARY + 350_000 - 800_000);
  });

  it('qonuniy ushlanmalar yig‘indisini gross maoshning 50 foizida cheklaydi', async () => {
    prisma.__state.adjustments.push({
      employeeId: EMPLOYEE_ID,
      month: MONTH,
      year: YEAR,
      status: PayrollAdjustmentStatus.APPROVED,
      type: PayrollAdjustmentType.DISCIPLINARY_FINE,
      proposedAmount: 4_000_000,
      approvedAmount: 4_000_000,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.disciplinaryFine).toBe(BASE_SALARY / 2);
    expect(preview.deferredDeduction).toBe(1_250_000);
    expect(preview.netSalary).toBe(BASE_SALARY / 2);
  });

  it('09:00–18:00 va 1 soat tushlik uchun stavkani 8 sof ish soatidan hisoblaydi', async () => {
    for (const schedule of prisma.__state.schedules) {
      schedule.shift = {
        startTime: '09:00',
        endTime: '18:00',
        isOvernight: false,
        lunchStart: '12:00',
        lunchEnd: '13:00',
      };
    }
    prisma.__state.attendanceRecords.push({
      employeeId: EMPLOYEE_ID,
      status: 'PRESENT',
      lateMinutes: 0,
      earlyLeaveMin: 60,
      overtimeMinutes: 0,
      netWorkMin: 420,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    const expected = Math.round(60 * (BASE_SALARY / (SCHEDULED_DAYS * 8 * 60)));

    expect(preview.earlyLeaveDeduction).toBe(expected);
  });

  it("chegirmalar baseSalary'dan oshib ketsa netSalary hech qachon manfiy bo'lmaydi (0'da to'xtaydi)", async () => {
    // Butun oy davomida kelmagan — jarima baseSalary'ning o'zidan katta bo'lishi kerak
    for (let i = 0; i < SCHEDULED_DAYS; i++) {
      prisma.__state.attendanceRecords.push({
        employeeId: EMPLOYEE_ID,
        status: 'ABSENT',
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 0,
      });
    }
    // Ustiga qo'shimcha katta kechikish jarimasi
    prisma.__state.weeklyStats.push({
      employeeId: EMPLOYEE_ID,
      deductionAmount: 10_000_000,
    });

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.netSalary).toBe(0);
  });

  it("scheduledDays 0 bo'lganda (jadval yo'q) dailyRate/minuteRate 0 bo'ladi va xato tashlamaydi", async () => {
    prisma.__state.schedules.length = 0; // jadval yo'q

    const { preview } = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);

    expect(preview.scheduledDays).toBe(0);
    expect(preview.netSalary).toBe(BASE_SALARY);
  });
});
