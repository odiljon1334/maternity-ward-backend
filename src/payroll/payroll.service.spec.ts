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
  const leaves: any[] = [];
  const payrollRecords: any[] = [];

  return {
    __state: {
      employees,
      attendanceRecords,
      weeklyStats,
      schedules,
      adjustments,
      advances,
      leaves,
      payrollRecords,
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
          (s) =>
            s.employeeId === where.employeeId &&
            (where.status?.in ?? ['WORKING']).includes(s.status),
        ),
      ),
    },

    leaveRequest: {
      findMany: jest.fn(async ({ where }: any) =>
        leaves.filter((l) => l.employeeId === where.employeeId),
      ),
    },

    payrollRecord: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.employeeId_month_year;
        return (
          payrollRecords.find(
            (r) =>
              r.employeeId === k.employeeId &&
              r.month === k.month &&
              r.year === k.year,
          ) ?? null
        );
      }),
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

  it("grafik yo'q bo'lsa to'liq oylik BERILMAYDI — Du–Ju me'yori bo'yicha kelgan kunlar to'lanadi", async () => {
    prisma.__state.schedules.length = 0; // jadval yo'q

    const empty = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    // 2026-mart: 22 ta ish kuni (Du–Ju), hech biriga kelmagan
    expect(empty.details.basis).toBe('WEEKDAY_NORM');
    expect(empty.details.warnings).toContain('NO_SCHEDULE');
    expect(empty.preview.scheduledDays).toBe(22);
    expect(empty.preview.netSalary).toBe(0);

    // Hamma ish kunlari kelgan — to'liq oylik
    for (let d = 1; d <= 31; d++) {
      const date = new Date(`2026-03-${String(d).padStart(2, '0')}T00:00:00+05:00`);
      prisma.__state.attendanceRecords.push({
        employeeId: EMPLOYEE_ID,
        workDate: date,
        status: 'PRESENT',
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        netWorkMin: 480,
      });
    }
    const full = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    expect(full.preview.netSalary).toBe(BASE_SALARY);
  });

  function datedSchedule(day: number, extra: any = {}) {
    return {
      id: `s-${day}`,
      employeeId: EMPLOYEE_ID,
      status: 'WORKING',
      shiftId: 'shift-1',
      date: new Date(`2026-03-${String(day).padStart(2, '0')}T00:00:00+05:00`),
      shift: { startTime: '08:00', endTime: '17:00', isOvernight: false, lunchStart: '12:00', lunchEnd: '13:00' },
      ...extra,
    };
  }
  function present(day: number) {
    return {
      employeeId: EMPLOYEE_ID,
      scheduleId: `s-${day}`,
      workDate: new Date(`2026-03-${String(day).padStart(2, '0')}T00:00:00+05:00`),
      status: 'PRESENT',
      lateMinutes: 0,
      earlyLeaveMin: 0,
      overtimeMinutes: 0,
      netWorkMin: 480,
    };
  }

  it("haqsiz ta'til ish kunlari ushlanadi, pullik ta'til to'lanadi, dam olish kuni me'yorga kirmaydi", async () => {
    prisma.__state.schedules.length = 0;
    // 10 ish kuni: 6 tasiga kelgan, 2 tasi pullik ta'til, 2 tasi haqsiz
    for (let d = 2; d <= 7; d++) {
      prisma.__state.schedules.push(datedSchedule(d));
      prisma.__state.attendanceRecords.push(present(d));
    }
    prisma.__state.schedules.push(
      datedSchedule(9, { status: 'VACATION', preLeaveStatus: 'WORKING', note: "Ta'til: Yillik" }),
      datedSchedule(10, { status: 'VACATION', preLeaveStatus: 'WORKING', note: "Ta'til: Yillik" }),
      datedSchedule(16, { status: 'VACATION', note: "Ta'til: Haqsiz" }), // eski yozuv (shiftId bor)
      datedSchedule(17, { status: 'OTHER_ABSENCE', preLeaveStatus: 'WORKING', note: "Ta'til: Haqsiz" }),
      // Dam olish kuniga tushgan ta'til — me'yorga kirmaydi
      datedSchedule(8, { status: 'VACATION', preLeaveStatus: 'DAY_OFF', shiftId: null, note: "Ta'til: Yillik" }),
    );
    prisma.__state.leaves.push(
      { employeeId: EMPLOYEE_ID, type: 'VACATION', startDate: new Date('2026-03-08T00:00:00+05:00'), endDate: new Date('2026-03-10T00:00:00+05:00') },
      { employeeId: EMPLOYEE_ID, type: 'UNPAID', startDate: new Date('2026-03-16T00:00:00+05:00'), endDate: new Date('2026-03-17T00:00:00+05:00') },
    );

    const r = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    expect(r.preview.scheduledDays).toBe(10);
    expect(r.details.paidLeaveDays).toBe(2);
    expect(r.preview.unpaidLeaveDays).toBe(2);
    expect(r.preview.totalAbsences).toBe(0);
    expect(r.preview.unpaidLeaveDeduction).toBe(Math.round((BASE_SALARY / 10) * 2));
    expect(r.preview.netSalary).toBe(Math.round(BASE_SALARY * 0.8));
  });

  it("oy o'rtasida ketgan xodim — ketgandan keyingi kunlar to'lanmaydi (bugundan keyin bo'lsa ham)", async () => {
    prisma.__state.schedules.length = 0;
    for (let d = 2; d <= 11; d++) {
      prisma.__state.schedules.push(datedSchedule(d));
      if (d <= 6) prisma.__state.attendanceRecords.push(present(d));
    }
    prisma.__state.employees[0].firedAt = new Date('2026-03-06T10:00:00+05:00');
    const r = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    expect(r.details.notEmployedDays).toBe(5);
    expect(r.details.warnings).toContain('PARTIAL_EMPLOYMENT');
    expect(r.preview.netSalary).toBe(Math.round(BASE_SALARY / 2));
  });

  it("o'tgan oy tasdiqlangan hisobida qolgan ushlanma va avans shu oyga o'tadi", async () => {
    prisma.__state.payrollRecords.push({
      employeeId: EMPLOYEE_ID,
      month: 2,
      year: 2026,
      status: 'APPROVED',
      deferredDeduction: 300_000,
      deferredAdvance: 200_000,
    });
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
    const r = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    expect(r.preview.carriedDeduction).toBe(300_000);
    expect(r.preview.carriedAdvance).toBe(200_000);
    expect(r.preview.netSalary).toBe(BASE_SALARY - 500_000);

    // DRAFT (tasdiqlanmagan) oldingi oy — o'tkazilmaydi
    prisma.__state.payrollRecords[0].status = 'DRAFT';
    const r2 = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    expect(r2.preview.carriedDeduction).toBe(0);
    expect(r2.preview.netSalary).toBe(BASE_SALARY);
  });

  it('faqat hisobga kirgan KPI/avans ID lari qaytariladi (saqlashda shular APPLIED bo‘ladi)', async () => {
    prisma.__state.adjustments.push(
      { id: 'adj-1', employeeId: EMPLOYEE_ID, month: MONTH, year: YEAR, status: PayrollAdjustmentStatus.APPROVED, type: PayrollAdjustmentType.ONE_TIME_AWARD, proposedAmount: 1000, approvedAmount: 1000 },
      { id: 'adj-2', employeeId: EMPLOYEE_ID, month: MONTH, year: YEAR, status: PayrollAdjustmentStatus.APPLIED, type: PayrollAdjustmentType.ONE_TIME_AWARD, proposedAmount: 1000, approvedAmount: 1000 },
    );
    prisma.__state.advances.push({ id: 'adv-1', employeeId: EMPLOYEE_ID, month: MONTH, year: YEAR, status: SalaryAdvanceStatus.PAID, paidAmount: 5000 });
    const r = await service.calculate(EMPLOYEE_ID, MONTH, YEAR);
    expect(r.appliedAdjustmentIds).toEqual(['adj-1']);
    expect(r.appliedAdvanceIds).toEqual(['adv-1']);
  });
});
