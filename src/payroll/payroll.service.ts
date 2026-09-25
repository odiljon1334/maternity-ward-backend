/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { unexcusedLate } from '../attendance-notices/notice-excuse.util';
import { DateUtil } from '../common/utils/date.util';
import { isHospitalBlocked } from '../common/utils/payment.util';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PushService } from '../push/push.service';
import { calcShiftNetMinutes } from '../common/utils/shift.util';
import {
  LeaveStatus,
  LeaveType,
  PayrollAdjustmentStatus,
  PayrollAdjustmentType,
  SalaryAdvanceStatus,
  ScheduleStatus,
} from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/** Ta'til tasdiqlanganda grafikka yoziladigan holatlar */
export const LEAVE_SCHEDULE_STATUSES: ScheduleStatus[] = [
  ScheduleStatus.VACATION,
  ScheduleStatus.SICK,
  ScheduleStatus.MATERNITY_LEAVE,
  ScheduleStatus.OTHER_ABSENCE,
];

/** Oylikdan ushlanadigan ta'til turlari */
const UNPAID_LEAVE_TYPES: LeaveType[] = [LeaveType.UNPAID];

/**
 * Ta'til kuni ish kunining o'rniga tushganmi (me'yorga kiradimi).
 * Yangi yozuvlarda `preLeaveStatus` saqlanadi; eskilarida grafik
 * generatori faqat ish kunlariga smena qo'yadi — smenasi bor ta'til kuni
 * ilgari ish kuni bo'lgan.
 */
export function replacedWorkingDay(row: {
  status: ScheduleStatus;
  preLeaveStatus?: ScheduleStatus | null;
  shiftId?: string | null;
  note?: string | null;
}): boolean {
  if (!LEAVE_SCHEDULE_STATUSES.includes(row.status)) return false;
  if (row.preLeaveStatus) return row.preLeaveStatus === ScheduleStatus.WORKING;
  return !!row.shiftId && (row.note ?? '').startsWith("Ta'til");
}

/** Oyning Dushanba–Juma kunlari (Toshkent vaqti bo'yicha kun boshi, ms) */
export function weekdaysOfMonth(year: number, month: number): number[] {
  const first = dayjs.tz(`${year}-${String(month).padStart(2, '0')}-01`, TZ);
  const days: number[] = [];
  for (let i = 0; i < first.daysInMonth(); i++) {
    const d = first.add(i, 'day');
    const wd = d.day();
    if (wd >= 1 && wd <= 5) days.push(d.startOf('day').valueOf());
  }
  return days;
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  // ──────────────────────────────────────────
  // CALCULATE payroll for employee/month
  // ──────────────────────────────────────────
  async calculate(
    employeeId: string,
    month: number,
    year: number,
    hospitalId?: string | null,
  ) {
    const emp = hospitalId
      ? await this.prisma.employee.findFirst({
          where: { id: employeeId, hospitalId },
        })
      : await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);
    const warnings: string[] = [];

    // Get attendance records
    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, workDate: { gte: start, lte: end } },
    });

    const baseSalary = Number(emp.baseSalary);
    const workDays = records.filter((r) => r.status !== 'ABSENT').length;
    const explicitAbsences = records.filter(
      (r) => r.status === 'ABSENT',
    ).length;
    // Tasdiqlangan "Kechikaman" xabari bilan uzrli qism hisoblanmaydi
    const totalLateMin = records.reduce((s, r) => s + unexcusedLate(r), 0);
    const totalEarlyMin = records.reduce((s, r) => s + r.earlyLeaveMin, 0);
    const totalOvertimeMin = records.reduce((s, r) => s + r.overtimeMinutes, 0);
    // Sof ish vaqti: checkIn/checkOut bo'lgan kunlardagi netWorkMin yig'indisi
    const totalNetWorkMin = records.reduce(
      (s, r) => s + (r.netWorkMin ?? 0),
      0,
    );

    // ── Oylik me'yor (norma) ────────────────────────────────────────────────
    // Ish kunlari + ish kuniga to'g'ri kelgan ta'til kunlari. Ilgari ta'til
    // kunlari me'yordan butunlay chiqib ketardi: haqsiz ta'tilda ham to'liq
    // oylik chiqardi, grafigi yo'q xodim esa kelmasa ham to'liq oylik olardi.
    const [scheduleRows, leaves] = await Promise.all([
      this.prisma.schedule.findMany({
        where: {
          employeeId,
          date: { gte: start, lte: end },
          status: { in: [ScheduleStatus.WORKING, ...LEAVE_SCHEDULE_STATUSES] },
        },
        include: { shift: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          status: { in: [LeaveStatus.APPROVED, LeaveStatus.COMPLETED] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { type: true, startDate: true, endDate: true },
      }),
    ]);

    const dayKey = (d: Date) => DateUtil.startOfDay(d).getTime();
    const leaveTypeOn = (day: number): LeaveType | null => {
      const hit = leaves.find(
        (l) => dayKey(l.startDate) <= day && day <= dayKey(l.endDate),
      );
      return hit ? hit.type : null;
    };
    const isUnpaidLeave = (day: number | null, status: ScheduleStatus) => {
      const type = day !== null ? leaveTypeOn(day) : null;
      if (type) return UNPAID_LEAVE_TYPES.includes(type);
      return status === ScheduleStatus.OTHER_ABSENCE;
    };

    type PlanDay = {
      day: number | null; // eski/test ma'lumotlarida sana bo'lmasligi mumkin
      kind: 'WORK' | 'LEAVE';
      unpaid: boolean;
      minutes: number;
      scheduleId?: string;
    };
    let plan: PlanDay[] = [];
    for (const row of scheduleRows) {
      const minutes = row.shift ? calcShiftNetMinutes(row.shift) : 12 * 60; // eski, shiftsiz grafiklar uchun moslik
      const day = row.date ? dayKey(row.date) : null;
      if (row.status === ScheduleStatus.WORKING) {
        plan.push({
          day,
          kind: 'WORK',
          unpaid: false,
          minutes,
          scheduleId: row.id,
        });
      } else if (replacedWorkingDay(row)) {
        plan.push({
          day,
          kind: 'LEAVE',
          unpaid: isUnpaidLeave(day, row.status),
          minutes,
        });
      }
    }

    // Grafik umuman yo'q — 5 kunlik hafta (Du–Ju, 8 soat) me'yori bo'yicha
    let basis: 'SCHEDULE' | 'WEEKDAY_NORM' = 'SCHEDULE';
    if (!plan.length) {
      basis = 'WEEKDAY_NORM';
      warnings.push('NO_SCHEDULE');
      plan = weekdaysOfMonth(year, month).map((day) => {
        const type = leaveTypeOn(day);
        return type
          ? {
              day,
              kind: 'LEAVE' as const,
              unpaid: UNPAID_LEAVE_TYPES.includes(type),
              minutes: 8 * 60,
            }
          : { day, kind: 'WORK' as const, unpaid: false, minutes: 8 * 60 };
      });
    }

    const scheduledDays = plan.length;
    const scheduledMinutes = plan.reduce((s, p) => s + p.minutes, 0);

    // Ishga kirishdan oldingi / ishdan ketgandan keyingi kunlar to'lanmaydi
    // (oy o'rtasida ketgan xodimning yakuniy hisobi)
    const hiredDay = emp.hiredAt ? dayKey(emp.hiredAt) : null;
    const firedDay = emp.firedAt ? dayKey(emp.firedAt) : null;
    const outsideEmployment = (day: number | null) =>
      day !== null &&
      ((hiredDay !== null && day < hiredDay) ||
        (firedDay !== null && day > firedDay));

    const attendedScheduleIds = new Set(
      records.map((record) => record.scheduleId).filter(Boolean),
    );
    const attendedDays = new Set(
      records
        .map((record) => record.workDate)
        .filter(Boolean)
        .map((date) => dayKey(date)),
    );
    const todayStart = dayKey(new Date());

    let inferredAbsences = 0;
    let notEmployedDays = 0;
    let paidLeaveDays = 0;
    let unpaidLeaveDays = 0;
    for (const p of plan) {
      if (outsideEmployment(p.day)) {
        notEmployedDays++;
        continue;
      }
      if (p.kind === 'LEAVE') {
        if (p.unpaid) unpaidLeaveDays++;
        else paidLeaveDays++;
        continue;
      }
      if (p.day === null || p.day >= todayStart) continue;
      if (p.scheduleId && attendedScheduleIds.has(p.scheduleId)) continue;
      if (attendedDays.has(p.day)) continue;
      inferredAbsences++;
    }
    const absences = explicitAbsences + inferredAbsences + notEmployedDays;
    if (notEmployedDays) warnings.push('PARTIAL_EMPLOYMENT');

    const dailyRate = scheduledDays > 0 ? baseSalary / scheduledDays : 0;
    const minuteRate = scheduledMinutes > 0 ? baseSalary / scheduledMinutes : 0;

    // Deductions
    const absenceDeduction = absences * dailyRate;
    const unpaidLeaveDeduction = unpaidLeaveDays * dailyRate;

    // Kechikish — davomat fakti. U Mehnat kodeksidagi tushuntirish, buyruq
    // va tanishtirish jarayonisiz avtomatik pul jarimasiga aylantirilmaydi.
    // Qonuniy tasdiqlangan intizomiy ushlanma alohida payroll ledger orqali
    // qo'llanadi; legacy maydon yangi hisoblarda nol bo'lib qoladi.
    const lateDeduction = 0;

    // Early leave deduction (every minute)
    const earlyLeaveDeduction = totalEarlyMin * minuteRate;

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const [adjustments, advances, prevRecord] = await Promise.all([
      this.prisma.payrollAdjustment.findMany({
        where: {
          employeeId,
          month,
          year,
          status: {
            in: [
              PayrollAdjustmentStatus.APPROVED,
              PayrollAdjustmentStatus.APPLIED,
            ],
          },
        },
        select: {
          id: true,
          status: true,
          type: true,
          approvedAmount: true,
          proposedAmount: true,
        },
      }),
      this.prisma.salaryAdvance.findMany({
        where: {
          employeeId,
          month,
          year,
          status: {
            in: [SalaryAdvanceStatus.PAID, SalaryAdvanceStatus.APPLIED],
          },
        },
        select: {
          id: true,
          status: true,
          paidAmount: true,
          approvedAmount: true,
        },
      }),
      // O'tgan oyning tasdiqlangan hisobida 50% chegarasi yoki oylik
      // yetmagani sabab keyinga qolgan ushlanma/avans shu oyga o'tadi
      this.prisma.payrollRecord.findUnique({
        where: {
          employeeId_month_year: {
            employeeId,
            month: prevMonth,
            year: prevYear,
          },
        },
        select: {
          status: true,
          deferredDeduction: true,
          deferredAdvance: true,
        },
      }),
    ]);

    const prevFinal =
      prevRecord?.status === 'APPROVED' || prevRecord?.status === 'PAID';
    const carriedDeduction = prevFinal
      ? Number(prevRecord!.deferredDeduction ?? 0)
      : 0;
    const carriedAdvance = prevFinal
      ? Number(prevRecord!.deferredAdvance ?? 0)
      : 0;

    const adjustmentAmount = (type: PayrollAdjustmentType) =>
      adjustments
        .filter((item) => item.type === type)
        .reduce(
          (sum, item) =>
            sum + Number(item.approvedAmount ?? item.proposedAmount),
          0,
        );
    const contractualKpiBonus = adjustmentAmount(
      PayrollAdjustmentType.CONTRACTUAL_KPI_BONUS,
    );
    const oneTimeAward = adjustmentAmount(PayrollAdjustmentType.ONE_TIME_AWARD);
    // Kech check-outning o'zi overtime to'lovi uchun yetarli emas. Faqat
    // rozilik/asos va Director qarori bilan tasdiqlangan summa qo'shiladi.
    const overtimeBonus = adjustmentAmount(PayrollAdjustmentType.OVERTIME_PAY);
    const requestedDisciplinaryFine = adjustmentAmount(
      PayrollAdjustmentType.DISCIPLINARY_FINE,
    );
    const requestedOtherDeduction =
      adjustmentAmount(PayrollAdjustmentType.OTHER_LAWFUL_DEDUCTION) +
      carriedDeduction;
    const advancePaid =
      advances.reduce(
        (sum, item) =>
          sum + Number(item.paidAmount ?? item.approvedAmount ?? 0),
        0,
      ) + carriedAdvance;

    const grossSalary = Math.max(
      0,
      baseSalary -
        absenceDeduction -
        unpaidLeaveDeduction -
        lateDeduction -
        earlyLeaveDeduction +
        overtimeBonus +
        contractualKpiBonus +
        oneTimeAward,
    );
    // MK 270: umumiy ushlanmalar, odatda, har bir to'lovning 50%idan oshmaydi.
    const deductionCap = grossSalary * 0.5;
    const requestedLawfulDeductions =
      requestedDisciplinaryFine + requestedOtherDeduction;
    const appliedLawfulDeductions = Math.min(
      requestedLawfulDeductions,
      deductionCap,
    );
    const disciplinaryFine = Math.min(
      requestedDisciplinaryFine,
      appliedLawfulDeductions,
    );
    const otherLawfulDeduction = Math.max(
      0,
      appliedLawfulDeductions - disciplinaryFine,
    );
    const deferredDeduction = Math.max(
      0,
      requestedLawfulDeductions - appliedLawfulDeductions,
    );
    const advanceApplied = Math.min(
      advancePaid,
      Math.max(0, grossSalary - appliedLawfulDeductions),
    );
    const deferredAdvance = Math.max(0, advancePaid - advanceApplied);

    const netSalary = Math.max(
      0,
      grossSalary - appliedLawfulDeductions - advanceApplied,
    );

    return {
      preview: {
        employeeId,
        month,
        year,
        baseSalary,
        scheduledDays,
        totalWorkDays: workDays,
        totalAbsences: absences,
        totalLateMin,
        totalEarlyMin,
        totalOvertimeMin,
        totalNetWorkMin,
        absenceDeduction: Math.round(absenceDeduction),
        unpaidLeaveDays,
        unpaidLeaveDeduction: Math.round(unpaidLeaveDeduction),
        lateDeduction: Math.round(lateDeduction),
        earlyLeaveDeduction: Math.round(earlyLeaveDeduction),
        overtimeBonus: Math.round(overtimeBonus),
        contractualKpiBonus: Math.round(contractualKpiBonus),
        oneTimeAward: Math.round(oneTimeAward),
        disciplinaryFine: Math.round(disciplinaryFine),
        otherLawfulDeduction: Math.round(otherLawfulDeduction),
        deferredDeduction: Math.round(deferredDeduction),
        carriedDeduction: Math.round(carriedDeduction),
        advancePaid: Math.round(advancePaid),
        advanceApplied: Math.round(advanceApplied),
        deferredAdvance: Math.round(deferredAdvance),
        carriedAdvance: Math.round(carriedAdvance),
        grossSalary: Math.round(grossSalary),
        netSalary: Math.round(netSalary),
      },
      // Saqlanmaydigan izohlar (UI uchun)
      details: {
        basis,
        warnings,
        paidLeaveDays,
        notEmployedDays,
      },
      // Shu hisobga kirgan yozuvlar — saqlashda FAQAT shular APPLIED bo'ladi
      appliedAdjustmentIds: adjustments
        .filter((a) => a.status === PayrollAdjustmentStatus.APPROVED)
        .map((a) => a.id),
      appliedAdvanceIds: advances
        .filter((a) => a.status === SalaryAdvanceStatus.PAID)
        .map((a) => a.id),
    };
  }

  // ──────────────────────────────────────────
  // SAVE/CREATE payroll record
  // ──────────────────────────────────────────
  async createOrUpdate(
    employeeId: string,
    month: number,
    year: number,
    manualBonus = 0,
    manualDeduction = 0,
    note?: string,
    hospitalId?: string | null,
  ) {
    // JSON body'da satr bo'lib kelishi mumkin
    month = Number(month);
    year = Number(year);
    if (
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isInteger(year) ||
      year < 2000 ||
      year > 2100
    ) {
      throw new BadRequestException("Oy yoki yil noto'g'ri");
    }
    if (manualBonus !== 0 || manualDeduction !== 0) {
      throw new BadRequestException(
        'Qo‘l bonus/kesimi o‘rniga sabab va tasdiq auditi bo‘lgan KPI, mukofot yoki qonuniy ushlanma workflowidan foydalaning',
      );
    }
    // hospitalId — chaqiruvchi muassasasi (SUPER_ADMIN uchun null): boshqa
    // muassasa xodimi "topilmadi" bo'ladi
    const { preview, appliedAdjustmentIds, appliedAdvanceIds } =
      await this.calculate(employeeId, month, year, hospitalId);

    // scheduledDays, employeeId, month, year — DB modelida yo'q yoki where clause da
    const {
      scheduledDays: _s,
      employeeId: _e,
      month: _m,
      year: _y,
      ...dbFields
    } = preview;
    const data = {
      ...dbFields,
      manualBonus: 0,
      manualDeduction: 0,
      note,
    };

    // Bitta tranzaksiya: yozuv va unga kirgan KPI/ushlanma/avanslar birga
    // yoziladi. Faqat HISOBGA KIRGAN yozuvlar APPLIED bo'ladi — ilgari
    // hisob va saqlash orasida tasdiqlangan ushlanma ham APPLIED bo'lib,
    // hech qaysi oylikka tushmay yo'qolardi.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.payrollRecord.findUnique({
        where: { employeeId_month_year: { employeeId, month, year } },
        select: { id: true, status: true },
      });
      // Tasdiqlangan/to'langan payroll immutable. Keyingi o'zgarishlar yangi
      // davr yoki alohida korrektirovka/reversiya orqali yuritiladi.
      if (existing && existing.status !== 'DRAFT') {
        return tx.payrollRecord.findUnique({ where: { id: existing.id } });
      }

      let record;
      if (existing) {
        // Parallel tasdiqlangan bo'lsa DRAFT'ga qaytarib yubormaymiz
        const updated = await tx.payrollRecord.updateMany({
          where: { id: existing.id, status: 'DRAFT' },
          data,
        });
        record = await tx.payrollRecord.findUnique({
          where: { id: existing.id },
        });
        if (updated.count === 0) return record;
      } else {
        record = await tx.payrollRecord.create({
          data: { employeeId, month, year, ...data, status: 'DRAFT' },
        });
      }

      if (appliedAdjustmentIds.length) {
        await tx.payrollAdjustment.updateMany({
          where: {
            id: { in: appliedAdjustmentIds },
            status: PayrollAdjustmentStatus.APPROVED,
          },
          data: {
            status: PayrollAdjustmentStatus.APPLIED,
            payrollRecordId: record!.id,
          },
        });
      }
      if (appliedAdvanceIds.length) {
        await tx.salaryAdvance.updateMany({
          where: {
            id: { in: appliedAdvanceIds },
            status: SalaryAdvanceStatus.PAID,
          },
          data: {
            status: SalaryAdvanceStatus.APPLIED,
            payrollRecordId: record!.id,
          },
        });
      }
      return record;
    });
  }

  // ──────────────────────────────────────────
  // BULK GENERATE for all employees
  // ──────────────────────────────────────────
  async generateMonthlyPayroll(
    month: number,
    year: number,
    hospitalId?: string,
    departmentId?: string,
  ) {
    // Kasalxona to'lovi OVERDUE bo'lsa — maosh hisoblanmaydi
    if (hospitalId && (await isHospitalBlocked(this.prisma, hospitalId))) {
      this.logger.warn(
        `Hospital ${hospitalId} is BLOCKED — payroll generation skipped`,
      );
      return { month, year, total: 0, blocked: true, results: [] };
    }

    // Shu oyda kamida bir kun ishlagan xodimlar: oy o'rtasida ketganlar ham
    // (yakuniy hisob), oydan keyin ishga kirganlar esa yo'q
    const monthStart = DateUtil.startOfMonth(year, month);
    const monthEnd = DateUtil.endOfMonth(year, month);
    const where: any = {
      hiredAt: { lte: monthEnd },
      OR: [{ firedAt: null }, { firedAt: { gte: monthStart } }],
    };
    if (hospitalId) where.hospitalId = hospitalId;
    if (departmentId) where.departmentId = departmentId;

    const employees = await this.prisma.employee.findMany({
      where,
      select: { id: true, userId: true },
    });

    const results = [];
    const userIdMap: Record<string, string | null> = {};
    for (const e of employees) userIdMap[e.id] = e.userId;

    for (const emp of employees) {
      try {
        const record = await this.createOrUpdate(emp.id, month, year);
        results.push({
          employeeId: emp.id,
          status: 'ok',
          netSalary: Number(record?.netSalary ?? 0),
        });
        // Push xabarnoma — xodimga maosh hisoblandi
        const uid = userIdMap[emp.id];
        if (uid) {
          this.push
            .notifyPayrollGenerated(
              uid,
              month,
              year,
              Number(record?.netSalary ?? 0),
            )
            .catch(() => null);
        }
      } catch (e) {
        results.push({
          employeeId: emp.id,
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { month, year, total: results.length, results };
  }

  // ──────────────────────────────────────────
  // APPROVE payroll
  // ──────────────────────────────────────────
  async approve(id: string, hospitalId?: string | null) {
    const record = await this.prisma.payrollRecord.findFirst({
      where: { id, ...(hospitalId && { employee: { hospitalId } }) },
    });
    if (!record) throw new NotFoundException('Maosh yozuvi topilmadi');
    if (record.status !== 'DRAFT')
      throw new ConflictException(
        'Faqat DRAFT holatdagilarni tasdiqlash mumkin',
      );

    return this.prisma.payrollRecord.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
  }

  // ──────────────────────────────────────────
  // GET payroll list
  // ──────────────────────────────────────────
  async findAll(
    month: number,
    year: number,
    hospitalId?: string,
    departmentId?: string,
  ) {
    const where: any = { month, year };
    if (hospitalId || departmentId) {
      where.employee = {};
      if (hospitalId) where.employee.hospitalId = hospitalId;
      if (departmentId) where.employee.departmentId = departmentId;
    }
    return this.prisma.payrollRecord.findMany({
      where,
      include: {
        employee: { include: { department: true, position: true } },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
  }

  async findOne(
    employeeId: string,
    month: number,
    year: number,
    hospitalId?: string | null,
  ) {
    return this.prisma.payrollRecord.findFirst({
      where: {
        employeeId,
        month,
        year,
        ...(hospitalId && { employee: { hospitalId } }),
      },
      include: { employee: { include: { department: true, position: true } } },
    });
  }

  // ──────────────────────────────────────────
  // EXCEL EXPORT
  // ──────────────────────────────────────────
  async exportExcel(
    month: number,
    year: number,
    hospitalId?: string,
    departmentId?: string,
  ): Promise<Buffer> {
    const records = await this.findAll(month, year, hospitalId, departmentId);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`Maosh ${month}-${year}`);

    const monthNames = [
      '',
      'Yanvar',
      'Fevral',
      'Mart',
      'Aprel',
      'May',
      'Iyun',
      'Iyul',
      'Avgust',
      'Sentyabr',
      'Oktyabr',
      'Noyabr',
      'Dekabr',
    ];

    sheet.mergeCells('A1:AB1');
    sheet.getCell('A1').value =
      `Tug'ruq xona — ${monthNames[month]} ${year} — Oylik maosh jadvali`;
    sheet.getCell('A1').font = { bold: true, size: 14 };
    sheet.getCell('A1').alignment = { horizontal: 'center' };

    sheet.addRow([]);
    sheet.addRow([
      '№',
      'F.I.O',
      "Bo'lim",
      'Lavozim',
      'Asosiy maosh',
      'Ish kunlari',
      "Yo'qligi",
      'Kechikish (min)',
      'Erta ketish (min)',
      'Overtime (min)',
      'Sof ish vaqti (min)',
      'Sof ish vaqti (soat)',
      'Kechikish kesim',
      "Yo'qlik kesim",
      'Overtime bonus',
      'KPI bonus',
      'Bir martalik mukofot',
      'Intizomiy jarima',
      'Boshqa qonuniy ushlanma',
      'Keyingi davrga qoldirilgan ushlanma',
      'Avans',
      'Payrollga qo‘llangan avans',
      'Keyingi davrga qolgan avans',
      "Haqsiz ta'til (kun)",
      "Haqsiz ta'til kesimi",
      "O'tgan oydan ushlanma",
      "O'tgan oydan avans",
      'Gross maosh',
      "Qo'l bonus",
      "Qo'l kesim",
      'Net maosh',
      'Status',
    ]);

    const headerRow = sheet.getRow(3);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1565C0' },
    };
    headerRow.height = 25;

    records.forEach((r, i) => {
      const netMin = r.totalNetWorkMin ?? 0;
      sheet.addRow([
        i + 1,
        r.employee.fullName,
        r.employee.department.name,
        r.employee.position.name,
        Number(r.baseSalary),
        r.totalWorkDays,
        r.totalAbsences,
        r.totalLateMin,
        r.totalEarlyMin,
        r.totalOvertimeMin,
        netMin,
        +(netMin / 60).toFixed(2),
        Number(r.lateDeduction),
        Number(r.absenceDeduction),
        Number(r.overtimeBonus),
        Number(r.contractualKpiBonus),
        Number(r.oneTimeAward),
        Number(r.disciplinaryFine),
        Number(r.otherLawfulDeduction),
        Number(r.deferredDeduction),
        Number(r.advancePaid),
        Number(r.advanceApplied),
        Number(r.deferredAdvance),
        r.unpaidLeaveDays ?? 0,
        Number(r.unpaidLeaveDeduction ?? 0),
        Number(r.carriedDeduction ?? 0),
        Number(r.carriedAdvance ?? 0),
        Number(r.grossSalary),
        Number(r.manualBonus),
        Number(r.manualDeduction),
        Number(r.netSalary),
        r.status,
      ]);
    });

    sheet.columns = [
      { width: 4 },
      { width: 30 },
      { width: 20 },
      { width: 20 },
      { width: 15 },
      { width: 15 },
      { width: 20 },
      { width: 17 },
      { width: 22 },
      { width: 26 },
      { width: 15 },
      { width: 16 },
      { width: 12 },
      { width: 10 },
      { width: 15 },
      { width: 15 },
      { width: 14 },
      { width: 18 },
      { width: 18 },
      { width: 15 },
      { width: 14 },
      { width: 15 },
      { width: 12 },
      { width: 14 },
      { width: 16 },
      { width: 18 },
      { width: 16 },
      { width: 12 },
      { width: 15 },
      { width: 12 },
      { width: 18 },
      { width: 20 },
    ];

    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }

  // ──────────────────────────────────────────
  // EMPLOYEE: xodimning o'z maosh tarixini ko'rish
  // ──────────────────────────────────────────
  async findMyRecords(userId: string, month?: number, year?: number) {
    const emp = await this.prisma.employee.findFirst({ where: { userId } });
    if (!emp) throw new NotFoundException('Xodim topilmadi');

    const where: any = { employeeId: emp.id };
    if (month) where.month = month;
    if (year) where.year = year;

    return this.prisma.payrollRecord.findMany({
      where,
      include: { employee: { include: { department: true, position: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 24,
    });
  }

  // ──────────────────────────────────────────
  // EMPLOYEE: o'z varaqasini yuklab olish
  // ──────────────────────────────────────────
  async generateMyPayslipPdf(
    userId: string,
    month: number,
    year: number,
  ): Promise<Buffer> {
    const emp = await this.prisma.employee.findFirst({ where: { userId } });
    if (!emp) throw new NotFoundException('Xodim topilmadi');
    return this.generatePayslipPdf(emp.id, month, year);
  }

  // ──────────────────────────────────────────
  // PDF PAYSLIP
  // ──────────────────────────────────────────
  async generatePayslipPdf(
    employeeId: string,
    month: number,
    year: number,
    hospitalId?: string | null,
  ): Promise<Buffer> {
    // Fetch saved record first; if not found, calculate on the fly
    const record = await this.prisma.payrollRecord.findFirst({
      where: {
        employeeId,
        month,
        year,
        ...(hospitalId && { employee: { hospitalId } }),
      },
      include: {
        employee: {
          include: { department: true, position: true, hospital: true },
        },
      },
    });

    // If no saved record, calculate preview
    let previewData: any = null;
    let emp: any = null;

    if (!record) {
      emp = hospitalId
        ? await this.prisma.employee.findFirst({
            where: { id: employeeId, hospitalId },
            include: { department: true, position: true, hospital: true },
          })
        : await this.prisma.employee.findUnique({
            where: { id: employeeId },
            include: { department: true, position: true, hospital: true },
          });
      if (!emp) throw new NotFoundException('Xodim topilmadi');
      const { preview } = await this.calculate(
        employeeId,
        month,
        year,
        hospitalId,
      );
      previewData = preview;
    } else {
      emp = record.employee;
    }

    const MONTH_NAMES = [
      '',
      'Yanvar',
      'Fevral',
      'Mart',
      'Aprel',
      'May',
      'Iyun',
      'Iyul',
      'Avgust',
      'Sentyabr',
      'Oktyabr',
      'Noyabr',
      'Dekabr',
    ];

    const fmtMoney = (v: number | string) => {
      const n = Math.round(Number(v));
      return n.toLocaleString('ru-RU') + " so'm";
    };
    const fmtMin = (m: number) => {
      if (!m) return '0 daq';
      const h = Math.floor(m / 60);
      const min = m % 60;
      return h > 0 ? `${h} soat ${min} daq` : `${min} daq`;
    };

    // Resolve values from record or preview
    const baseSalary = record
      ? Number(record.baseSalary)
      : previewData.baseSalary;
    const totalWorkDays = record
      ? record.totalWorkDays
      : previewData.totalWorkDays;
    const totalAbsences = record
      ? record.totalAbsences
      : previewData.totalAbsences;
    const totalLateMin = record
      ? record.totalLateMin
      : previewData.totalLateMin;
    const totalEarlyMin = record
      ? record.totalEarlyMin
      : previewData.totalEarlyMin;
    const totalOvertimeMin = record
      ? record.totalOvertimeMin
      : previewData.totalOvertimeMin;
    const totalNetWorkMin = record
      ? (record.totalNetWorkMin ?? 0)
      : previewData.totalNetWorkMin;
    const absenceDeduction = record
      ? Number(record.absenceDeduction)
      : previewData.absenceDeduction;
    const lateDeduction = record
      ? Number(record.lateDeduction)
      : previewData.lateDeduction;
    const unpaidLeaveDays = record
      ? (record.unpaidLeaveDays ?? 0)
      : previewData.unpaidLeaveDays;
    const unpaidLeaveDeduction = record
      ? Number(record.unpaidLeaveDeduction ?? 0)
      : previewData.unpaidLeaveDeduction;
    const carriedDeduction = record
      ? Number(record.carriedDeduction ?? 0)
      : previewData.carriedDeduction;
    const carriedAdvance = record
      ? Number(record.carriedAdvance ?? 0)
      : previewData.carriedAdvance;
    const earlyLeaveDeduction = record
      ? Number(record.earlyLeaveDeduction)
      : previewData.earlyLeaveDeduction;
    const overtimeBonus = record
      ? Number(record.overtimeBonus)
      : previewData.overtimeBonus;
    const contractualKpiBonus = record
      ? Number(record.contractualKpiBonus)
      : previewData.contractualKpiBonus;
    const oneTimeAward = record
      ? Number(record.oneTimeAward)
      : previewData.oneTimeAward;
    const disciplinaryFine = record
      ? Number(record.disciplinaryFine)
      : previewData.disciplinaryFine;
    const otherLawfulDeduction = record
      ? Number(record.otherLawfulDeduction)
      : previewData.otherLawfulDeduction;
    const deferredDeduction = record
      ? Number(record.deferredDeduction)
      : previewData.deferredDeduction;
    const advancePaid = record
      ? Number(record.advancePaid)
      : previewData.advancePaid;
    const advanceApplied = record
      ? Number(record.advanceApplied)
      : previewData.advanceApplied;
    const deferredAdvance = record
      ? Number(record.deferredAdvance)
      : previewData.deferredAdvance;
    const grossSalary = record
      ? Number(record.grossSalary)
      : previewData.grossSalary;
    const manualBonus = record ? Number(record.manualBonus) : 0;
    const manualDeduction = record ? Number(record.manualDeduction) : 0;
    const netSalary = record ? Number(record.netSalary) : previewData.netSalary;
    const status = record?.status ?? 'PREVIEW';
    const hospitalName = (emp.hospital as any)?.name ?? "Tug'ruqxona";

    const totalDeductions =
      absenceDeduction +
      unpaidLeaveDeduction +
      earlyLeaveDeduction +
      disciplinaryFine +
      otherLawfulDeduction +
      advanceApplied +
      manualDeduction;
    const totalBonuses =
      overtimeBonus + contractualKpiBonus + oneTimeAward + manualBonus;

    // ── Build PDF ──────────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        info: {
          Title: `Maosh varaqasi — ${emp.fullName} — ${MONTH_NAMES[month]} ${year}`,
          Author: hospitalName,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595 - 100; // usable width (A4 - margins)
      const COLORS = {
        primary: '#4f46e5', // indigo
        success: '#16a34a',
        danger: '#dc2626',
        muted: '#6b7280',
        border: '#e5e7eb',
        dark: '#111827',
        lightBg: '#f9fafb',
        headerBg: '#4f46e5',
      };

      // ── HEADER BANNER ─────────────────────────────────────────────
      doc.rect(50, 40, W, 70).fill(COLORS.headerBg);

      doc
        .fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(16)
        .text('MAOSH VARAQASI', 50, 55, { width: W, align: 'center' });

      doc
        .font('Helvetica')
        .fontSize(10)
        .text(`${hospitalName}`, 50, 77, { width: W, align: 'center' });

      doc
        .font('Helvetica')
        .fontSize(11)
        .text(`${MONTH_NAMES[month]} ${year}`, 50, 92, {
          width: W,
          align: 'center',
        });

      // Status badge (top right)
      const statusLabel =
        status === 'APPROVED'
          ? 'TASDIQLANGAN'
          : status === 'PAID'
            ? "TO'LANGAN"
            : status === 'PREVIEW'
              ? "KO'RINISH"
              : 'QORALAMA';
      const statusColor =
        status === 'APPROVED'
          ? '#16a34a'
          : status === 'PAID'
            ? '#0284c7'
            : status === 'PREVIEW'
              ? '#9333ea'
              : '#d97706';

      doc.roundedRect(W - 10, 50, 90, 20, 4).fill(statusColor);
      doc
        .fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(statusLabel, W - 10, 57, { width: 90, align: 'center' });

      let y = 130;

      // ── EMPLOYEE INFO BOX ────────────────────────────────────────
      doc.rect(50, y, W, 56).fill(COLORS.lightBg).stroke(COLORS.border);
      doc
        .fillColor(COLORS.dark)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text("XODIM MA'LUMOTLARI", 62, y + 8);

      doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
      const col1x = 62,
        col2x = 62 + W / 2;
      doc.text('F.I.O:', col1x, y + 24);
      doc.text("Bo'lim:", col1x, y + 37);
      doc.text('Lavozim:', col2x, y + 24);
      doc.text('Xodim ID:', col2x, y + 37);

      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.dark);
      doc.text(emp.fullName, col1x + 40, y + 24);
      doc.text((emp.department as any)?.name ?? '—', col1x + 40, y + 37);
      doc.text((emp.position as any)?.name ?? '—', col2x + 55, y + 24);
      doc.text(emp.employeeNumber || emp.id.slice(0, 8), col2x + 55, y + 37);

      y += 72;

      // ── HELPER: draw section ────────────────────────────────────
      const drawSection = (
        title: string,
        rows: { label: string; value: string; color?: string }[],
      ) => {
        // Section title
        doc.rect(50, y, W, 20).fill('#e0e7ff');
        doc
          .fillColor(COLORS.primary)
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(title, 62, y + 6);
        y += 20;

        rows.forEach((row, i) => {
          const rowBg = i % 2 === 0 ? '#ffffff' : COLORS.lightBg;
          doc.rect(50, y, W, 18).fill(rowBg);
          doc
            .fillColor(COLORS.muted)
            .font('Helvetica')
            .fontSize(9)
            .text(row.label, 62, y + 5);
          doc
            .fillColor(row.color ?? COLORS.dark)
            .font('Helvetica-Bold')
            .fontSize(9)
            .text(row.value, 50, y + 5, { width: W - 10, align: 'right' });
          y += 18;
        });

        y += 6;
      };

      // ── SECTION 1: ISH VAQTI ───────────────────────────────────
      drawSection('ISH VAQTI VA DAVOMAT', [
        { label: 'Asosiy maosh', value: fmtMoney(baseSalary) },
        { label: 'Ish kunlari', value: `${totalWorkDays} kun` },
        { label: "Yo'qlik", value: `${totalAbsences} kun` },
        { label: 'Sof ish vaqti', value: fmtMin(totalNetWorkMin) },
      ]);

      // ── SECTION 2: KESIMLAR ───────────────────────────────────
      drawSection('HISOB-KITOB TUZATMALARI VA USHLANMALAR', [
        {
          label: "Yo'qlik uchun kesim",
          value: absenceDeduction > 0 ? `− ${fmtMoney(absenceDeduction)}` : '—',
          color: absenceDeduction > 0 ? COLORS.danger : undefined,
        },
        {
          label: `Haqsiz ta'til (${unpaidLeaveDays} kun)`,
          value:
            unpaidLeaveDeduction > 0
              ? `− ${fmtMoney(unpaidLeaveDeduction)}`
              : '—',
          color: unpaidLeaveDeduction > 0 ? COLORS.danger : undefined,
        },
        {
          label: 'Kechikish (faqat davomat fakti)',
          value: fmtMin(totalLateMin),
        },
        {
          label: 'Erta ketish uchun kesim',
          value:
            earlyLeaveDeduction > 0
              ? `− ${fmtMoney(earlyLeaveDeduction)}`
              : '—',
          color: earlyLeaveDeduction > 0 ? COLORS.danger : undefined,
        },
        {
          label: 'Tasdiqlangan intizomiy jarima',
          value: disciplinaryFine > 0 ? `− ${fmtMoney(disciplinaryFine)}` : '—',
          color: disciplinaryFine > 0 ? COLORS.danger : undefined,
        },
        {
          label: 'Boshqa qonuniy ushlanma',
          value:
            otherLawfulDeduction > 0
              ? `− ${fmtMoney(otherLawfulDeduction)}`
              : '—',
          color: otherLawfulDeduction > 0 ? COLORS.danger : undefined,
        },
        {
          label: 'Oldindan to‘langan avans',
          value: advanceApplied > 0 ? `− ${fmtMoney(advanceApplied)}` : '—',
          color: advanceApplied > 0 ? COLORS.danger : undefined,
        },
        {
          label: "O'tgan oydan o'tgan ushlanma / avans",
          value:
            carriedDeduction + carriedAdvance > 0
              ? `${fmtMoney(carriedDeduction)} / ${fmtMoney(carriedAdvance)}`
              : '—',
        },
        {
          label: 'Keyingi davrga qolgan avans',
          value: deferredAdvance > 0 ? fmtMoney(deferredAdvance) : '—',
        },
        {
          label: 'Limit sabab keyingi davrga qoldi',
          value: deferredDeduction > 0 ? fmtMoney(deferredDeduction) : '—',
        },
        {
          label: 'Jami kesimlar',
          value:
            totalDeductions > 0 ? `− ${fmtMoney(totalDeductions)}` : "0 so'm",
          color: totalDeductions > 0 ? COLORS.danger : undefined,
        },
      ]);

      // ── SECTION 3: BONUSLAR ───────────────────────────────────
      drawSection('BONUSLAR', [
        {
          label: 'Overtime bonus',
          value: overtimeBonus > 0 ? `+ ${fmtMoney(overtimeBonus)}` : '—',
          color: overtimeBonus > 0 ? COLORS.success : undefined,
        },
        {
          label: 'KPI bonusi',
          value:
            contractualKpiBonus > 0
              ? `+ ${fmtMoney(contractualKpiBonus)}`
              : '—',
          color: contractualKpiBonus > 0 ? COLORS.success : undefined,
        },
        {
          label: 'Bir martalik mukofot',
          value: oneTimeAward > 0 ? `+ ${fmtMoney(oneTimeAward)}` : '—',
          color: oneTimeAward > 0 ? COLORS.success : undefined,
        },
        { label: 'Erta ketish', value: fmtMin(totalEarlyMin) },
        { label: 'Overtime', value: fmtMin(totalOvertimeMin) },
        {
          label: 'Hisoblangan gross maosh',
          value: fmtMoney(grossSalary),
        },
        {
          label: 'Jami bonuslar',
          value: totalBonuses > 0 ? `+ ${fmtMoney(totalBonuses)}` : "0 so'm",
          color: totalBonuses > 0 ? COLORS.success : undefined,
        },
      ]);

      // ── NET SALARY (large box) ─────────────────────────────────
      y += 4;
      doc.rect(50, y, W, 50).fill('#f0fdf4').stroke('#86efac');
      doc
        .fillColor(COLORS.success)
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('SOF MAOSH', 62, y + 10);
      doc
        .fillColor(COLORS.dark)
        .font('Helvetica-Bold')
        .fontSize(18)
        .text(fmtMoney(netSalary), 50, y + 24, {
          width: W - 10,
          align: 'right',
        });

      y += 64;

      // ── CALCULATION NOTES ─────────────────────────────────────
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
      doc.text(
        `Hisoblash formulasi: Asosiy maosh − Yo'qlik kesimi − Kechikish kesimi − Erta ketish kesimi + Overtime bonus`,
        50,
        y,
        { width: W },
      );
      y += 14;

      // ── SIGNATURE SECTION ─────────────────────────────────────
      y += 10;
      doc.rect(50, y, W, 60).fill('#ffffff').stroke(COLORS.border);

      const sigW = (W - 20) / 2;
      // Left: Director
      doc
        .fillColor(COLORS.muted)
        .font('Helvetica')
        .fontSize(8)
        .text('Direktor imzosi:', 62, y + 10);
      doc
        .moveTo(62, y + 38)
        .lineTo(62 + sigW - 20, y + 38)
        .stroke(COLORS.border);
      doc
        .fillColor(COLORS.dark)
        .font('Helvetica')
        .fontSize(8)
        .text('Sana: _____ / _____ / _______', 62, y + 44);

      // Right: Employee
      doc
        .fillColor(COLORS.muted)
        .font('Helvetica')
        .fontSize(8)
        .text('Xodim imzosi:', 62 + sigW + 10, y + 10);
      doc
        .moveTo(62 + sigW + 10, y + 38)
        .lineTo(62 + W - 10, y + 38)
        .stroke(COLORS.border);
      doc
        .fillColor(COLORS.dark)
        .font('Helvetica')
        .fontSize(8)
        .text('Sana: _____ / _____ / _______', 62 + sigW + 10, y + 44);

      // ── FOOTER ────────────────────────────────────────────────
      y += 74;
      doc
        .fillColor(COLORS.muted)
        .font('Helvetica')
        .fontSize(7)
        .text(
          `Ushbu hujjat ${hospitalName} tomonidan avtomatik ravishda yaratilgan. Sana: ${new Date().toLocaleDateString('uz-UZ')}.`,
          50,
          y,
          { width: W, align: 'center' },
        );

      doc.end();
    });
  }
}
