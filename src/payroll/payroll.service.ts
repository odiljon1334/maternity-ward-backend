import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { OVERTIME_RATE } from '../common/constants';
import * as ExcelJS from 'exceljs';
import { PayrollStatus } from '@prisma/client';

@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────
  // CALCULATE payroll for employee/month
  // ──────────────────────────────────────────
  async calculate(employeeId: string, month: number, year: number) {
    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    // Get attendance records
    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, workDate: { gte: start, lte: end } },
    });

    // Get weekly stats for this month (for late deductions)
    const weeklyStats = await this.prisma.weeklyAttendanceStat.findMany({
      where: {
        employeeId,
        weekStart: { gte: start, lte: end },
      },
    });

    const baseSalary = Number(emp.baseSalary);
    const workDays = records.filter(r => r.status !== 'ABSENT').length;
    const absences = records.filter(r => r.status === 'ABSENT').length;
    const totalLateMin = records.reduce((s, r) => s + r.lateMinutes, 0);
    const totalEarlyMin = records.reduce((s, r) => s + r.earlyLeaveMin, 0);
    const totalOvertimeMin = records.reduce((s, r) => s + r.overtimeMinutes, 0);

    // Scheduled work days in this month
    const scheduledDays = await this.prisma.schedule.count({
      where: {
        employeeId,
        date: { gte: start, lte: end },
        status: 'WORKING',
      },
    });

    const dailyRate = scheduledDays > 0 ? baseSalary / scheduledDays : 0;
    const minuteRate = scheduledDays > 0 ? baseSalary / (scheduledDays * 12 * 60) : 0;

    // Deductions
    const absenceDeduction = absences * dailyRate;

    // Late deduction: haftalik 2 soatdan oshgan kechikish
    const lateDeduction = weeklyStats.reduce(
      (sum, ws) => sum + Number(ws.deductionAmount),
      0,
    );

    // Early leave deduction (every minute)
    const earlyLeaveDeduction = totalEarlyMin * minuteRate;

    // Overtime bonus
    const overtimeBonus = totalOvertimeMin * minuteRate * OVERTIME_RATE;

    const netSalary = Math.max(
      0,
      baseSalary - absenceDeduction - lateDeduction - earlyLeaveDeduction + overtimeBonus,
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
        absenceDeduction: Math.round(absenceDeduction),
        lateDeduction: Math.round(lateDeduction),
        earlyLeaveDeduction: Math.round(earlyLeaveDeduction),
        overtimeBonus: Math.round(overtimeBonus),
        netSalary: Math.round(netSalary),
      },
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
  ) {
    const { preview } = await this.calculate(employeeId, month, year);

    const netWithManual = Math.max(
      0,
      preview.netSalary + manualBonus - manualDeduction,
    );

    return this.prisma.payrollRecord.upsert({
      where: { employeeId_month_year: { employeeId, month, year } },
      update: {
        ...preview,
        manualBonus,
        manualDeduction,
        netSalary: netWithManual,
        note,
        status: 'DRAFT',
      },
      create: {
        ...preview,
        manualBonus,
        manualDeduction,
        netSalary: netWithManual,
        note,
        status: 'DRAFT',
      },
    });
  }

  // ──────────────────────────────────────────
  // BULK GENERATE for all employees
  // ──────────────────────────────────────────
  async generateMonthlyPayroll(month: number, year: number) {
    const employees = await this.prisma.employee.findMany({
      where: { firedAt: null },
      select: { id: true },
    });

    const results = [];
    for (const emp of employees) {
      try {
        const record = await this.createOrUpdate(emp.id, month, year);
        results.push({ employeeId: emp.id, status: 'ok', netSalary: Number(record.netSalary) });
      } catch (e) {
        results.push({ employeeId: emp.id, status: 'error', error: e.message });
      }
    }

    return { month, year, total: results.length, results };
  }

  // ──────────────────────────────────────────
  // APPROVE payroll
  // ──────────────────────────────────────────
  async approve(id: string) {
    const record = await this.prisma.payrollRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maosh yozuvi topilmadi');
    if (record.status !== 'DRAFT') throw new ConflictException('Faqat DRAFT holatdagilarni tasdiqlash mumkin');

    return this.prisma.payrollRecord.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
  }

  // ──────────────────────────────────────────
  // GET payroll list
  // ──────────────────────────────────────────
  async findAll(month: number, year: number) {
    return this.prisma.payrollRecord.findMany({
      where: { month, year },
      include: {
        employee: { include: { department: true, position: true } },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
  }

  async findOne(employeeId: string, month: number, year: number) {
    return this.prisma.payrollRecord.findUnique({
      where: { employeeId_month_year: { employeeId, month, year } },
      include: { employee: { include: { department: true, position: true } } },
    });
  }

  // ──────────────────────────────────────────
  // EXCEL EXPORT
  // ──────────────────────────────────────────
  async exportExcel(month: number, year: number): Promise<Buffer> {
    const records = await this.findAll(month, year);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`Maosh ${month}-${year}`);

    const monthNames = ['', 'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
      'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

    sheet.mergeCells('A1:N1');
    sheet.getCell('A1').value = `Tug'ruq xona — ${monthNames[month]} ${year} — Oylik maosh jadvali`;
    sheet.getCell('A1').font = { bold: true, size: 14 };
    sheet.getCell('A1').alignment = { horizontal: 'center' };

    sheet.addRow([]);
    sheet.addRow([
      '№', 'F.I.O', 'Bo\'lim', 'Lavozim',
      'Asosiy maosh', 'Ish kunlari', 'Yo\'qligi',
      'Kechikish (min)', 'Erta ketish (min)', 'Overtime (min)',
      'Kechikish kesim', 'Yo\'qlik kesim', 'Overtime bonus',
      'Qo\'l bonus', 'Qo\'l kesim', 'Net maosh', 'Status',
    ]);

    const headerRow = sheet.getRow(3);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    headerRow.height = 25;

    records.forEach((r, i) => {
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
        Number(r.lateDeduction),
        Number(r.absenceDeduction),
        Number(r.overtimeBonus),
        Number(r.manualBonus),
        Number(r.manualDeduction),
        Number(r.netSalary),
        r.status,
      ]);
    });

    sheet.columns = [
      { width: 4 }, { width: 30 }, { width: 20 }, { width: 20 },
      { width: 15 }, { width: 12 }, { width: 10 }, { width: 15 },
      { width: 15 }, { width: 14 }, { width: 15 }, { width: 14 },
      { width: 15 }, { width: 12 }, { width: 12 }, { width: 15 }, { width: 12 },
    ];

    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }
}
