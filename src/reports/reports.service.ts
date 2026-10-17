import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { AttendanceService } from '../attendance/attendance.service';
import { PayrollService } from '../payroll/payroll.service';
import { unexcusedLate } from '../attendance-notices/notice-excuse.util';
import {
  localDateParts,
  localMonthBoundsMs,
  splitIntervalMinutesByLocalDate,
} from '../schedule-planning/schedule-planning-time';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attendanceService: AttendanceService,
    private readonly payrollService: PayrollService,
  ) {}

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex++;
          results[index] = await mapper(items[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  // ─────────────────────────────────────────────
  // ATTENDANCE EXCEL REPORT
  // ─────────────────────────────────────────────
  async generateAttendanceExcel(query: {
    month: number;
    year: number;
    departmentId?: string;
    hospitalId?: string;
  }): Promise<ExcelJS.Buffer> {
    const { month, year, departmentId, hospitalId } = query;

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    const daysInMonth = endDate.getDate();

    // Hodimlar — davomat bo'lmasa ham barchasi ko'rinadi
    const employees = await this.prisma.employee.findMany({
      where: {
        firedAt: null,
        ...(departmentId ? { departmentId } : {}),
        ...(hospitalId ? { hospitalId } : {}),
      },
      include: {
        department: { select: { name: true } },
        position: { select: { name: true } },
        attendances: {
          where: {
            workDate: { gte: startDate, lte: endDate },
          },
          orderBy: { workDate: 'asc' },
        },
      },
      orderBy: [{ department: { name: 'asc' } }, { fullName: 'asc' }],
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Maternity Ward Attendance';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(
      `${year}-${String(month).padStart(2, '0')} Davomat`,
      {
        pageSetup: { orientation: 'landscape', fitToPage: true },
      },
    );

    // ── Header ──
    const monthName = dayjs(`${year}-${month}-01`).format('MMMM YYYY');
    sheet.mergeCells(1, 1, 1, daysInMonth + 8);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = `Davomat hisoboti — ${monthName}`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 30;

    // ── Column headers ──
    const headers = [
      { header: '№', width: 4 },
      { header: 'F.I.O', width: 25 },
      { header: "Bo'lim", width: 18 },
      { header: 'Lavozim', width: 20 },
      { header: 'Ish kunlari', width: 11 },
      { header: 'Keldi', width: 8 },
      { header: 'Kelmadi', width: 9 },
      { header: 'Kechikdi', width: 10 },
    ];

    // Day columns
    for (let d = 1; d <= daysInMonth; d++) {
      headers.push({ header: String(d), width: 4 });
    }

    const headerRow = sheet.getRow(2);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h.header;
      cell.font = { bold: true, size: 10 };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1976D2' },
      };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
      sheet.getColumn(i + 1).width = h.width;
    });
    headerRow.height = 35;

    // ── Data rows ──
    const statusSymbols: Record<string, string> = {
      PRESENT: '✓',
      LATE: 'K', // Kechikdi
      ABSENT: '—',
      EARLY_LEAVE: 'E', // Erta ketdi
      LATE_EARLY: 'KE',
    };

    const statusColors: Record<string, string> = {
      PRESENT: 'FFE8F5E9',
      LATE: 'FFFFF9C4',
      ABSENT: 'FFFFEBEE',
      EARLY_LEAVE: 'FFFFF3E0',
      LATE_EARLY: 'FFFCE4EC',
    };

    employees.forEach((emp, idx) => {
      const row = sheet.getRow(idx + 3);

      // Attendance map: day → record
      const attMap = new Map<number, (typeof emp.attendances)[0]>();
      emp.attendances.forEach((a) => {
        const day = new Date(a.workDate).getDate();
        attMap.set(day, a);
      });

      let daysWorked = 0;
      let daysAbsent = 0;
      let daysLate = 0;

      emp.attendances.forEach((a) => {
        if (
          a.status === 'PRESENT' ||
          a.status === 'LATE' ||
          a.status === 'EARLY_LEAVE' ||
          a.status === 'LATE_EARLY'
        )
          daysWorked++;
        if (a.status === 'ABSENT') daysAbsent++;
        if (a.status === 'LATE' || a.status === 'LATE_EARLY') daysLate++;
      });

      // AttendanceRecord faqat ish kuni uchun yaratiladi; ABSENT ham ish kuni.
      // Shu sabab jami = kelgan + kelmagan, aks holda 13 kelgan + 1 kelmagan
      // holati noto'g'ri ravishda "13 ish kuni" bo'lib chiqardi.
      const totalWorkDays = daysWorked + daysAbsent;

      row.getCell(1).value = idx + 1;
      row.getCell(2).value = emp.fullName;
      row.getCell(3).value = emp.department.name;
      row.getCell(4).value = emp.position.name;
      row.getCell(5).value = totalWorkDays;
      row.getCell(6).value = daysWorked;
      row.getCell(7).value = daysAbsent;
      row.getCell(8).value = daysLate;

      // Day cells
      for (let d = 1; d <= daysInMonth; d++) {
        const cell = row.getCell(8 + d);
        const date = new Date(year, month - 1, d);
        const dow = date.getDay();
        const isWeekend = dow === 0 || dow === 6;

        const att = attMap.get(d);
        // Grafik yagona manba: shanba/yakshanba ham ish kuni bo'lishi mumkin.
        // Davomat yozuvi bo'lsa — holati ko'rsatiladi, bo'lmasa dam olish.
        if (!att && isWeekend) {
          cell.value = '○';
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF5F5F5' },
          };
        } else if (att) {
          cell.value = statusSymbols[att.status] || '?';
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: statusColors[att.status] || 'FFFFFFFF' },
          };
        } else {
          cell.value = '';
        }
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'hair' },
          left: { style: 'hair' },
          bottom: { style: 'hair' },
          right: { style: 'hair' },
        };
      }

      // Row style
      [1, 2, 3, 4, 5, 6, 7, 8].forEach((c) => {
        const cell = row.getCell(c);
        cell.alignment = {
          horizontal: c === 2 ? 'left' : 'center',
          vertical: 'middle',
        };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
        if (idx % 2 === 0) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFAFAFA' },
          };
        }
      });
      row.height = 18;
    });

    // ── Legend ──
    const legendRow = sheet.getRow(employees.length + 4);
    legendRow.getCell(1).value = 'Belgilar:';
    legendRow.getCell(1).font = { bold: true };
    legendRow.getCell(2).value =
      '✓ = Keldi  |  K = Kechikdi  |  E = Erta ketdi  |  — = Kelmadi  |  ○ = Dam olish kuni';
    sheet.mergeCells(employees.length + 4, 2, employees.length + 4, 10);

    return workbook.xlsx.writeBuffer() as Promise<ExcelJS.Buffer>;
  }

  // ─────────────────────────────────────────────
  // PAYROLL EXCEL REPORT
  // ─────────────────────────────────────────────
  async generatePayrollExcel(query: {
    month: number;
    year: number;
    departmentId?: string;
    hospitalId?: string;
  }): Promise<ExcelJS.Buffer> {
    const { month, year, departmentId, hospitalId } = query;

    const empWhere: any = {
      firedAt: null,
      ...(departmentId ? { departmentId } : {}),
      ...(hospitalId ? { hospitalId } : {}),
    };

    // Barcha hodimlarni olish (payroll bo'lmasa ham)
    const employees = await this.prisma.employee.findMany({
      where: empWhere,
      include: {
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
      orderBy: [{ department: { name: 'asc' } }, { fullName: 'asc' }],
    });

    // Payroll yozuvi bo'lgan hodimlar uchun to'liq ma'lumot
    const payrollRecords = await this.prisma.payrollRecord.findMany({
      where: { month, year, employee: empWhere },
      select: {
        employeeId: true,
        totalWorkDays: true,
        totalAbsences: true,
        totalLateMin: true,
        totalEarlyMin: true,
        totalOvertimeMin: true,
        totalNetWorkMin: true,
        baseSalary: true,
        absenceDeduction: true,
        lateDeduction: true,
        earlyLeaveDeduction: true,
        overtimeBonus: true,
        manualBonus: true,
        manualDeduction: true,
        contractualKpiBonus: true,
        oneTimeAward: true,
        disciplinaryFine: true,
        otherLawfulDeduction: true,
        deferredDeduction: true,
        advancePaid: true,
        advanceApplied: true,
        deferredAdvance: true,
        grossSalary: true,
        netSalary: true,
        status: true,
      },
    });
    const payMap = new Map(payrollRecords.map((p) => [p.employeeId, p]));

    const employeeIds = employees.map((employee) => employee.id);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);
    const attendanceRecords = employeeIds.length
      ? await this.prisma.attendanceRecord.findMany({
          where: {
            employeeId: { in: employeeIds },
            workDate: { gte: startDate, lte: endDate },
          },
          select: {
            employeeId: true,
            lateMinutes: true,
            excusedLateMin: true,
            earlyLeaveMin: true,
            overtimeMinutes: true,
          },
        })
      : [];
    const attendanceDays = new Map<
      string,
      { lateDays: number; earlyLeaveDays: number; overtimeDays: number }
    >();
    for (const attendance of attendanceRecords) {
      const stats = attendanceDays.get(attendance.employeeId) ?? {
        lateDays: 0,
        earlyLeaveDays: 0,
        overtimeDays: 0,
      };
      if (unexcusedLate(attendance) > 0) stats.lateDays += 1;
      if (attendance.earlyLeaveMin > 0) stats.earlyLeaveDays += 1;
      if (attendance.overtimeMinutes > 0) stats.overtimeDays += 1;
      attendanceDays.set(attendance.employeeId, stats);
    }

    // APPROVED/PAID yozuv o'zgarmas snapshot bo'lib qoladi. DRAFT yoki hali
    // yaratilmagan payroll esa export vaqtida haqiqiy grafik va davomatdan
    // qayta hisoblanadi; export DBga yozmaydi va xodimga bildirishnoma yubormaydi.
    const calculatedEntries = await this.mapWithConcurrency(
      employees.filter((employee) => {
        const saved = payMap.get(employee.id);
        return !saved || saved.status === 'DRAFT';
      }),
      5,
      async (employee) => {
        try {
          const { preview } = await this.payrollService.calculate(
            employee.id,
            month,
            year,
            hospitalId,
          );
          return [employee.id, preview] as const;
        } catch (error) {
          this.logger.warn(
            `Payroll report calculation failed for employee ${employee.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [employee.id, null] as const;
        }
      },
    );
    const calculatedMap = new Map(calculatedEntries);

    const records = employees.map((employee) => {
      const saved = payMap.get(employee.id);
      const calculated = calculatedMap.get(employee.id);
      const finalized =
        saved?.status === 'APPROVED' || saved?.status === 'PAID';
      const values = finalized ? saved : calculated || saved || null;
      const dayStats = attendanceDays.get(employee.id) ?? {
        lateDays: 0,
        earlyLeaveDays: 0,
        overtimeDays: 0,
      };
      const scheduledDays = calculated
        ? calculated.scheduledDays
        : saved
          ? saved.totalWorkDays + saved.totalAbsences
          : null;

      return {
        employee,
        scheduledDays,
        ...dayStats,
        totalWorkDays: values?.totalWorkDays ?? null,
        totalAbsences: values?.totalAbsences ?? null,
        totalLateMin: values?.totalLateMin ?? null,
        totalEarlyMin: values?.totalEarlyMin ?? null,
        totalOvertimeMin: values?.totalOvertimeMin ?? null,
        totalNetWorkMin: values?.totalNetWorkMin ?? null,
        baseSalary: values?.baseSalary ?? employee.baseSalary,
        absenceDeduction: values?.absenceDeduction ?? null,
        earlyLeaveDeduction: values?.earlyLeaveDeduction ?? null,
        overtimeBonus: values?.overtimeBonus ?? null,
        contractualKpiBonus: values?.contractualKpiBonus ?? null,
        oneTimeAward: values?.oneTimeAward ?? null,
        disciplinaryFine: values?.disciplinaryFine ?? null,
        otherLawfulDeduction: values?.otherLawfulDeduction ?? null,
        deferredDeduction: values?.deferredDeduction ?? null,
        advancePaid: values?.advancePaid ?? null,
        advanceApplied: values?.advanceApplied ?? null,
        deferredAdvance: values?.deferredAdvance ?? null,
        grossSalary: values?.grossSalary ?? null,
        netSalary: values?.netSalary ?? null,
        status: saved?.status ?? (calculated ? 'CALCULATED' : 'ERROR'),
      };
    });

    const workbook = new ExcelJS.Workbook();
    const monthName = dayjs(`${year}-${month}-01`).format('MMMM YYYY');
    const sheet = workbook.addWorksheet(`${monthName} Maosh`);

    // Header
    const cols = [
      '№',
      'F.I.O',
      "Bo'lim",
      'Lavozim',
      'Rejadagi ish kunlari',
      'Kelgan kunlar',
      'Kelmagan kunlar',
      'Kech qolgan kunlar',
      'Kechikish (min)',
      'Erta ketgan kunlar',
      'Erta ketish (min)',
      'Overtime kunlari',
      'Overtime (min)',
      'Sof ish vaqti (soat)',
      'Bazaviy maosh',
      'Ishlanmagan vaqt tuzatmasi',
      'Erta ketish tuzatmasi',
      'Overtime to\u2018lovi',
      'KPI bonusi',
      'Bir martalik mukofot',
      'Intizomiy jarima',
      'Boshqa qonuniy ushlanma',
      'Keyingi davrga qoldi',
      'Avans',
      'Payrollga qo‘llangan avans',
      'Keyingi davrga qolgan avans',
      'Hisoblangan ish haqi (gross)',
      'Yakuniy to\u2018lov',
      'Holat',
    ];

    sheet.addRow([]);
    sheet.mergeCells(1, 1, 1, cols.length);
    const title = sheet.getCell(1, 1);
    title.value = `Oylik hisob-kitob — ${monthName}`;
    title.font = { bold: true, size: 13 };
    title.alignment = { horizontal: 'center' };
    sheet.getRow(1).height = 28;

    const colRow = sheet.addRow(cols);
    colRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1565C0' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
    colRow.height = 40;

    // Widths
    const widths = [
      4, 26, 18, 20, 18, 12, 13, 17, 14, 17, 15, 15, 14, 18, 16, 22, 20, 17, 14,
      18, 18, 20, 22, 14, 20, 22, 24, 18, 24,
    ];
    widths.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    let totalNet = 0;

    records.forEach((r, idx) => {
      const statusLabel =
        r.status === 'PAID'
          ? "To'langan"
          : r.status === 'APPROVED'
            ? 'Tasdiqlangan'
            : r.status === 'CALCULATED'
              ? 'Hisoblanmagan (hisob)'
              : r.status === 'ERROR'
                ? 'Hisoblash xatosi'
                : 'Loyiha';
      const net = r.netSalary == null ? null : Number(r.netSalary);
      if (net != null) totalNet += net;

      const row = sheet.addRow([
        idx + 1,
        r.employee.fullName,
        r.employee.department.name,
        r.employee.position.name,
        r.scheduledDays,
        r.totalWorkDays,
        r.totalAbsences,
        r.lateDays,
        r.totalLateMin,
        r.earlyLeaveDays,
        r.totalEarlyMin,
        r.overtimeDays,
        r.totalOvertimeMin,
        r.totalNetWorkMin == null
          ? null
          : Number((r.totalNetWorkMin / 60).toFixed(2)),
        Number(r.baseSalary),
        r.absenceDeduction == null ? null : Number(r.absenceDeduction),
        r.earlyLeaveDeduction == null ? null : Number(r.earlyLeaveDeduction),
        r.overtimeBonus == null ? null : Number(r.overtimeBonus),
        r.contractualKpiBonus == null ? null : Number(r.contractualKpiBonus),
        r.oneTimeAward == null ? null : Number(r.oneTimeAward),
        r.disciplinaryFine == null ? null : Number(r.disciplinaryFine),
        r.otherLawfulDeduction == null ? null : Number(r.otherLawfulDeduction),
        r.deferredDeduction == null ? null : Number(r.deferredDeduction),
        r.advancePaid == null ? null : Number(r.advancePaid),
        r.advanceApplied == null ? null : Number(r.advanceApplied),
        r.deferredAdvance == null ? null : Number(r.deferredAdvance),
        r.grossSalary == null ? null : Number(r.grossSalary),
        net,
        statusLabel,
      ]);

      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.border = {
          top: { style: 'hair' },
          left: { style: 'hair' },
          bottom: { style: 'hair' },
          right: { style: 'hair' },
        };
        if (colNum >= 15 && colNum <= 28) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right' };
        } else {
          cell.alignment = {
            horizontal: colNum === 2 ? 'left' : 'center',
            vertical: 'middle',
          };
        }
        if (idx % 2 === 0) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF8F9FA' },
          };
        }
      });

      // Net salary highlight
      const netCell = row.getCell(28);
      netCell.font = { bold: true };
      netCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE3F2FD' },
      };
      row.height = 18;
    });

    // Total row
    const totalRow = sheet.addRow([
      '',
      'JAMI',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      totalNet,
      '',
    ]);
    totalRow.getCell(2).font = { bold: true };
    totalRow.getCell(28).font = { bold: true };
    totalRow.getCell(28).numFmt = '#,##0';
    totalRow.getCell(28).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFBBDEFB' },
    };
    sheet.views = [{ state: 'frozen', xSplit: 4, ySplit: 2 }];
    sheet.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: 2, column: cols.length },
    };

    return workbook.xlsx.writeBuffer() as Promise<ExcelJS.Buffer>;
  }

  // ─────────────────────────────────────────────
  // WEEKLY ATTENDANCE REPORT
  // ─────────────────────────────────────────────
  async generateWeeklyExcel(query: {
    weekStart: string; // YYYY-MM-DD (dushanba)
    departmentId?: string;
    hospitalId?: string;
  }): Promise<ExcelJS.Buffer> {
    const start = dayjs(query.weekStart).startOf('day').toDate();
    const end = dayjs(query.weekStart).add(6, 'day').endOf('day').toDate();

    const empWhere: any = {
      firedAt: null,
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.hospitalId ? { hospitalId: query.hospitalId } : {}),
    };

    // 1) Barcha hodimlarni olish
    const employees = await this.prisma.employee.findMany({
      where: empWhere,
      include: {
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
      orderBy: [{ department: { name: 'asc' } }, { fullName: 'asc' }],
    });

    // 2) Hafta davomidagi mavjud davomat yozuvlari
    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        workDate: { gte: start, lte: end },
        employee: empWhere,
      },
      orderBy: [{ employee: { fullName: 'asc' } }, { workDate: 'asc' }],
    });

    // Davomat yo'q kunni faqat haqiqiy WORKING grafik mavjud bo'lsa
    // "kelmadi" deyish mumkin. Grafikning o'zi bo'lmasa taxmin qilmaymiz.
    const schedules = await this.prisma.schedule.findMany({
      where: {
        date: { gte: start, lte: end },
        employee: empWhere,
      },
      orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
    });

    // Map: employeeId → Map<dateStr, record>
    const recMap = new Map<string, Map<string, (typeof records)[0]>>();
    for (const r of records) {
      const ds = dayjs(r.workDate).format('YYYY-MM-DD');
      if (!recMap.has(r.employeeId)) recMap.set(r.employeeId, new Map());
      recMap.get(r.employeeId)!.set(ds, r);
    }

    const scheduleMap = new Map<string, Map<string, (typeof schedules)[0]>>();
    for (const schedule of schedules) {
      const ds = dayjs(schedule.date).format('YYYY-MM-DD');
      if (!scheduleMap.has(schedule.employeeId)) {
        scheduleMap.set(schedule.employeeId, new Map());
      }
      scheduleMap.get(schedule.employeeId)!.set(ds, schedule);
    }

    const workbook = new ExcelJS.Workbook();
    const label = `${dayjs(start).format('DD.MM')}-${dayjs(end).format('DD.MM.YYYY')}`;
    const sheet = workbook.addWorksheet(`Haftalik ${label}`);

    // Ustunlar — hafta kunlari
    const weekDays: string[] = [];
    for (let i = 0; i < 7; i++)
      weekDays.push(dayjs(start).add(i, 'day').format('YYYY-MM-DD'));

    const dayLabels = weekDays.map((d) => dayjs(d).format('ddd DD.MM'));
    const cols = [
      '№',
      'F.I.O',
      "Bo'lim",
      'Lavozim',
      ...dayLabels,
      'Keldi',
      'Kelmadi',
      'Kechikdi',
    ];

    const headerRow = sheet.addRow(cols);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF37474F' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
    headerRow.height = 35;

    const statusSymbol: Record<string, string> = {
      PRESENT: '✓',
      LATE: 'K',
      ABSENT: '—',
      EARLY_LEAVE: 'E',
      LATE_EARLY: 'KE',
      DAY_OFF: '○',
      VACATION: 'T',
      SICK: 'KAS',
      HOLIDAY: 'B',
      MATERNITY_LEAVE: 'TT',
      TRAINING: 'MO',
      OTHER_ABSENCE: 'B',
    };
    const statusColor: Record<string, string> = {
      PRESENT: 'FFE8F5E9',
      LATE: 'FFFFF9C4',
      ABSENT: 'FFFFEBEE',
      EARLY_LEAVE: 'FFFFF3E0',
      LATE_EARLY: 'FFFCE4EC',
    };

    employees.forEach((emp, idx) => {
      const dayMap = recMap.get(emp.id) ?? new Map();
      const employeeSchedules = scheduleMap.get(emp.id) ?? new Map();
      let came = 0,
        absent = 0,
        late = 0;

      const dayCells = weekDays.map((ds) => {
        const dow = dayjs(ds).day(); // 0=Sun, 6=Sat
        const rec = dayMap.get(ds);
        const schedule = employeeSchedules.get(ds);
        if (!rec) {
          if (!schedule) {
            return dow === 0 || dow === 6
              ? { val: '○', color: 'FFF5F5F5' }
              : { val: '', color: 'FFFFFFFF' };
          }

          if (schedule.status !== 'WORKING') {
            return {
              val: statusSymbol[schedule.status] || '',
              color: 'FFF5F5F5',
            };
          }

          // Faqat o'tib ketgan rejalashtirilgan ish kuni "kelmadi".
          // Bugungi/kelgusi smena hali yakunlanmagan bo'lishi mumkin.
          if (dayjs(ds).endOf('day').isBefore(dayjs())) {
            absent++;
            return { val: '—', color: 'FFFFEBEE' };
          }
          return { val: '·', color: 'FFFFFFFF' };
        }
        if (
          rec.status === 'PRESENT' ||
          rec.status === 'EARLY_LEAVE' ||
          rec.status === 'LATE' ||
          rec.status === 'LATE_EARLY'
        )
          came++;
        if (rec.status === 'ABSENT') absent++;
        if (rec.status === 'LATE' || rec.status === 'LATE_EARLY') late++;
        return {
          val: statusSymbol[rec.status] || '?',
          color: statusColor[rec.status] || 'FFFFFFFF',
        };
      });

      const row = sheet.addRow([
        idx + 1,
        emp.fullName,
        emp.department.name,
        emp.position.name,
        ...dayCells.map((c) => c.val),
        came,
        absent,
        late,
      ]);

      dayCells.forEach((c, di) => {
        const cell = row.getCell(5 + di);
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: c.color },
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'hair' },
          left: { style: 'hair' },
          bottom: { style: 'hair' },
          right: { style: 'hair' },
        };
      });

      [1, 2, 3, 4].forEach((c) => {
        row.getCell(c).alignment = {
          horizontal: c === 2 ? 'left' : 'center',
          vertical: 'middle',
        };
        row.getCell(c).border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      // Summary cells
      [5 + 7, 5 + 8, 5 + 9].forEach((c) => {
        row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell(c).font = { bold: true };
      });
      if (idx % 2 === 0) {
        [1, 2, 3, 4].forEach((c) => {
          row.getCell(c).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFAFAFA' },
          };
        });
      }
      row.height = 18;
    });

    // Legend
    const lgRow = sheet.addRow([]);
    lgRow.getCell(1).value = 'Belgilar:';
    lgRow.getCell(1).font = { bold: true };
    lgRow.getCell(2).value =
      '✓=Keldi  K=Kechikdi  E=Erta ketdi  —=Kelmadi  ○=Dam olish';
    sheet.mergeCells(lgRow.number, 2, lgRow.number, 8);

    // Column widths
    [4, 26, 18, 18, ...Array(7).fill(10), 7, 7, 7].forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    return workbook.xlsx.writeBuffer() as Promise<ExcelJS.Buffer>;
  }

  // ─────────────────────────────────────────────
  // T-13 TABEL (1C:Enterprise/ZUP uchun moslashtirilgan) — StaffPulse rejasi,
  // "O'zbekiston bozoriga mos integratsiyalar" bandi (2026-09-20).
  // ─────────────────────────────────────────────
  //
  // ⚠️ MUHIM CHEKLOV: bu yerda standart T-13 harfli kodlari (Я/Н/В/ОТ/Б)
  // ishlatilgan — bular buxgalterlar va 1C:ZUP tomonidan tanib olinadigan
  // umumiy standart. LEKIN bu rasmiy davlat blank shablonining ANIQ
  // katakma-katak ko'rinishi (OKUD/OKPO rekvizitlari, rasmiy o'lchamlar)
  // EMAS — bizning tizimimizda OKPO/STIR kabi maydonlar saqlanmaydi.
  // Buxgalteriyaga rasmiy blank kerak bo'lsa, aniq shablon berilishi va
  // shunga moslab qayta ko'rib chiqilishi kerak.
  //
  // Rasmiy kodlar: Я — ish vaqti, Н — TUNGI soatlar (22:00–06:00),
  // НН — sababi aniqlanmagan kelmaslik, В — dam olish/bayram, ОТ — ta'til,
  // Б — kasallik, Р — tug'ruq ta'tili, ПК — malaka oshirish.
  // ⚠️ Ilgari kelmagan kunga "Н" yozilardi — buxgalter va 1C uni tungi ish
  // deb o'qirdi.
  private static readonly T13_CODES: Record<string, string> = {
    PRESENT: 'Я',
    LATE: 'Я',
    EARLY_LEAVE: 'Я',
    LATE_EARLY: 'Я',
    ABSENT: 'НН',
    DAY_OFF: 'В',
    HOLIDAY: 'В',
    VACATION: 'ОТ',
    SICK: 'Б',
    MATERNITY_LEAVE: 'Р',
    TRAINING: 'ПК',
    OTHER_ABSENCE: 'НН',
    PLANNED: '',
  };

  private static readonly T13_WORKED_STATUSES = new Set([
    'PRESENT',
    'LATE',
    'EARLY_LEAVE',
    'LATE_EARLY',
  ]);

  async generateT13Excel(query: {
    month: number;
    year: number;
    departmentId?: string;
    hospitalId?: string;
  }): Promise<ExcelJS.Buffer> {
    const { month, year, departmentId, hospitalId } = query;
    const daysInMonth = new Date(year, month, 0).getDate();
    const { startMs: monthStartMs, endMs: monthEndMs } = localMonthBoundsMs(
      year,
      month,
    );
    const monthStart = new Date(monthStartMs);
    const nextMonthStart = new Date(monthEndMs);

    const [employees, hospital] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          // Oy ichida ishdan bo'shagan yoki ishga kirgan xodim ham tabelga
          // tushadi — ishlagan kunlari yo'qolmasligi kerak.
          OR: [{ firedAt: null }, { firedAt: { gte: monthStart } }],
          hiredAt: { lt: nextMonthStart },
          ...(departmentId ? { departmentId } : {}),
          ...(hospitalId ? { hospitalId } : {}),
        },
        include: {
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
        orderBy: [{ department: { name: 'asc' } }, { fullName: 'asc' }],
      }),
      hospitalId
        ? this.prisma.hospital.findUnique({ where: { id: hospitalId } })
        : Promise.resolve(null),
    ]);

    // Har bir xodim uchun kunlik davomatni (grafik asosida VACATION/SICK/
    // DAY_OFF/HOLIDAY ham hisobga olingan holda) parallel olib kelamiz —
    // AttendanceService.getEmployeeAttendance bilan bir xil, tekshirilgan
    // mantiq (davomat moduli allaqachon shu logikani ishlatadi).
    const attendanceByEmployee = await Promise.all(
      employees.map((emp) =>
        this.attendanceService.getEmployeeAttendance(emp.id, month, year, {
          includePlanned: true,
        }),
      ),
    );

    // O'tgan oyning oxirgi kunida boshlangan tungi smena — uning shu oyga
    // tushgan soatlari (masalan 31-dagi 20:00–08:00 → 1-sanaga 8 soat).
    const carryIn = employees.length
      ? await this.prisma.attendanceRecord.findMany({
          where: {
            employeeId: { in: employees.map((emp) => emp.id) },
            workDate: new Date(monthStartMs - 86_400_000),
            status: { in: [...ReportsService.T13_WORKED_STATUSES] as any },
          },
        })
      : [];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'StaffPulse (MaternityCare)';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(
      `T-13 ${year}-${String(month).padStart(2, '0')}`,
      { pageSetup: { orientation: 'landscape', fitToPage: true } },
    );

    const monthName = dayjs(`${year}-${month}-01`).format('MMMM YYYY');
    const totalCols = 4 + daysInMonth + 6; // №,FIO,Bo'lim,Lavozim + kunlar + 6 jami ustun

    sheet.mergeCells(1, 1, 1, totalCols);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = `Ishchi vaqtidan foydalanish tabeli (Forma T-13) — ${monthName}`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 26;

    sheet.mergeCells(2, 1, 2, totalCols);
    const orgCell = sheet.getCell(2, 1);
    orgCell.value = `Tashkilot: ${hospital?.name ?? 'Barcha shifoxonalar'}`;
    orgCell.font = { italic: true, size: 10 };
    orgCell.alignment = { horizontal: 'center' };

    // ── Ustun sarlavhalari (2 qatorli: kod + soat) ──
    const headerRowIdx = 4;
    const codesRowIdx = 5;
    const staticHeaders = ['№', 'F.I.O', "Bo'lim", 'Lavozim'];
    staticHeaders.forEach((h, i) => {
      sheet.mergeCells(headerRowIdx, i + 1, codesRowIdx, i + 1);
      const cell = sheet.getCell(headerRowIdx, i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1565C0' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
    });

    for (let d = 1; d <= daysInMonth; d++) {
      const col = 4 + d;
      const cell = sheet.getCell(headerRowIdx, col);
      cell.value = d;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1565C0' },
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getColumn(col).width = 4;

      const subCell = sheet.getCell(codesRowIdx, col);
      subCell.value = 'kod/soat';
      subCell.font = { italic: true, size: 7, color: { argb: 'FFFFFFFF' } };
      subCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1976D2' },
      };
      subCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    const totalsHeaders = [
      'Я (smena)',
      "ОТ (ta'til)",
      'Б (kasallik)',
      "НН (yo'qlik)",
      'Soat (jami)',
      'Н (tungi soat)',
    ];
    totalsHeaders.forEach((h, i) => {
      const col = 4 + daysInMonth + i + 1;
      sheet.mergeCells(headerRowIdx, col, codesRowIdx, col);
      const cell = sheet.getCell(headerRowIdx, col);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1565C0' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      sheet.getColumn(col).width = 10;
    });

    sheet.getColumn(1).width = 4;
    sheet.getColumn(2).width = 28;
    sheet.getColumn(3).width = 18;
    sheet.getColumn(4).width = 18;

    // ── Har bir xodim uchun 2 qator: kod qatori + soat qatori ──
    const round1 = (minutes: number) => Math.round(minutes / 6) / 10;
    let rowCursor = codesRowIdx + 1;
    employees.forEach((emp, idx) => {
      const records: any[] = attendanceByEmployee[idx].records;
      const days = this.t13DayCells(
        [...records, ...carryIn.filter((r) => r.employeeId === emp.id)],
        year,
        month,
      );
      const hiredDay = emp.hiredAt ? localDateParts(emp.hiredAt).iso : null;
      const firedDay = emp.firedAt ? localDateParts(emp.firedAt).iso : null;

      const codeRow = sheet.getRow(rowCursor);
      const hoursRow = sheet.getRow(rowCursor + 1);

      sheet.mergeCells(rowCursor, 1, rowCursor + 1, 1);
      sheet.mergeCells(rowCursor, 2, rowCursor + 1, 2);
      sheet.mergeCells(rowCursor, 3, rowCursor + 1, 3);
      sheet.mergeCells(rowCursor, 4, rowCursor + 1, 4);
      codeRow.getCell(1).value = idx + 1;
      codeRow.getCell(2).value = emp.fullName;
      codeRow.getCell(3).value = emp.department.name;
      codeRow.getCell(4).value = emp.position.name;
      [1, 2, 3, 4].forEach((c) => {
        codeRow.getCell(c).alignment = {
          horizontal: c === 2 ? 'left' : 'center',
          vertical: 'middle',
        };
      });

      // Smenalar soni — shu oyda boshlangan smenalar (tungi smena ikki
      // kunga tushsa ham bitta smena).
      let worked = 0;
      let vacation = 0;
      let sick = 0;
      let absent = 0;
      for (const record of records) {
        if (ReportsService.T13_WORKED_STATUSES.has(record.status)) worked++;
        else if (record.status === 'VACATION') vacation++;
        else if (record.status === 'SICK') sick++;
        else if (record.status === 'ABSENT') absent++;
      }
      let totalMinutes = 0;
      let nightMinutes = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const col = 4 + d;
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const day = days.get(iso);
        const employed =
          (!hiredDay || iso >= hiredDay) && (!firedDay || iso <= firedDay);

        const codes: string[] = [];
        let hoursValue: number | string = '';
        if (!employed) {
          // Ishga kirishdan oldin / ishdan ketgandan keyin — bo'sh
        } else if (day && day.workedMin > 0) {
          codes.push('Я');
          if (day.nightMin > 0) codes.push('Н');
          // Ishlagan soat bilan birga shu kunning boshqa holati (masalan
          // tungi smena tugagan kuni kelmagan bo'lsa) ham ko'rinadi.
          const extra = day.status
            ? ReportsService.T13_CODES[day.status]
            : undefined;
          if (extra && extra !== 'Я' && extra !== 'В') codes.push(extra);
          totalMinutes += day.workedMin;
          nightMinutes += day.nightMin;
          hoursValue =
            day.nightMin > 0
              ? `${round1(day.workedMin)}/${round1(day.nightMin)}`
              : round1(day.workedMin);
        } else if (day?.status) {
          const code = ReportsService.T13_CODES[day.status] ?? '';
          if (code) codes.push(code);
        } else {
          // Grafik qo'yilmagan kun — dam olish (grafik yagona manba)
          codes.push('В');
        }

        codeRow.getCell(col).value = codes.join(' ');
        codeRow.getCell(col).alignment = { horizontal: 'center' };
        codeRow.getCell(col).font = { size: 9 };
        hoursRow.getCell(col).value = hoursValue;
        hoursRow.getCell(col).alignment = { horizontal: 'center' };
        hoursRow.getCell(col).font = { size: 7, color: { argb: 'FF757575' } };
      }

      const totalsCol = 4 + daysInMonth;
      const totals = [
        worked,
        vacation,
        sick,
        absent,
        round1(totalMinutes),
        round1(nightMinutes),
      ];
      totals.forEach((value, i) => {
        const col = totalsCol + i + 1;
        sheet.mergeCells(rowCursor, col, rowCursor + 1, col);
        const cell = sheet.getCell(rowCursor, col);
        cell.value = value;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true };
      });

      if (idx % 2 === 0) {
        for (let c = 1; c <= totalsCol + totals.length; c++) {
          [codeRow.getCell(c), hoursRow.getCell(c)].forEach((cell) => {
            if (!cell.fill) {
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFAFAFA' },
              };
            }
          });
        }
      }

      rowCursor += 2;
    });

    // Belgilar izohi
    const legendRow = sheet.getRow(rowCursor + 1);
    legendRow.getCell(1).value = 'Kodlar:';
    legendRow.getCell(1).font = { bold: true };
    sheet.mergeCells(rowCursor + 1, 2, rowCursor + 1, totalCols);
    legendRow.getCell(2).value =
      "Я=Ishladi  Н=Tungi soatlar (22:00–06:00), soat qatorida \"jami/tungi\"  НН=Sababi aniqlanmagan kelmaslik  В=Dam olish/bayram (grafik qo'yilmagan kun ham)  ОТ=Navbatdagi ta'til  Б=Kasallik  Р=Tug'ruq ta'tili  ПК=Malaka oshirish. Tungi smena soatlari kalendar kunlariga bo'linadi (20:00–08:00 → 4 + 8).";

    return workbook.xlsx.writeBuffer() as Promise<ExcelJS.Buffer>;
  }

  /**
   * Har bir kalendar kun uchun ishlangan va tungi daqiqalar hamda holat.
   *
   * Ishlangan vaqt check-in/check-out (bo'lmasa grafik) oralig'i bo'yicha
   * Toshkent kunlariga bo'linadi va sof ish vaqtiga (netWorkMin)
   * proporsional moslanadi (tushlik va tanaffuslar chiqib ketadi).
   * Tungi daqiqalar — 22:00–06:00 bilan kesishgan qism.
   */
  private t13DayCells(records: any[], year: number, month: number) {
    const days = new Map<
      string,
      { workedMin: number; nightMin: number; status?: string }
    >();
    const cell = (iso: string) => {
      let value = days.get(iso);
      if (!value) {
        value = { workedMin: 0, nightMin: 0 };
        days.set(iso, value);
      }
      return value;
    };
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;

    for (const record of records) {
      const ownDay = localDateParts(record.workDate).iso;
      if (!ReportsService.T13_WORKED_STATUSES.has(record.status)) {
        if (ownDay.startsWith(monthPrefix)) cell(ownDay).status = record.status;
        continue;
      }
      const start = record.checkIn ?? record.expectedCheckIn;
      const end = record.checkOut ?? record.expectedCheckOut;
      const segments =
        start && end
          ? splitIntervalMinutesByLocalDate(start, end, year, month)
          : null;
      if (!segments) {
        // Vaqtlar noma'lum — sof ish vaqti o'z kuniga yoziladi
        if (ownDay.startsWith(monthPrefix)) {
          cell(ownDay).workedMin += record.netWorkMin ?? 0;
        }
        continue;
      }
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      const spanMin = (endMs - startMs) / 60_000;
      const net =
        record.netWorkMin && record.netWorkMin > 0
          ? record.netWorkMin
          : spanMin;
      const factor = spanMin > 0 ? Math.min(1, net / spanMin) : 0;
      for (const [iso, minutes] of Object.entries(segments)) {
        const target = cell(iso);
        target.workedMin += minutes * factor;
        target.nightMin +=
          ReportsService.nightOverlapMinutes(iso, startMs, endMs) * factor;
      }
    }
    return days;
  }

  /** Shu kalendar kunidagi 00:00–06:00 va 22:00–24:00 bilan kesishuv (daqiqa). */
  private static nightOverlapMinutes(
    iso: string,
    startMs: number,
    endMs: number,
  ) {
    const dayStart = dayjs.tz(iso, TZ).startOf('day').valueOf();
    const windows: Array<[number, number]> = [
      [dayStart, dayStart + 6 * 3_600_000],
      [dayStart + 22 * 3_600_000, dayStart + 24 * 3_600_000],
    ];
    let total = 0;
    for (const [from, to] of windows) {
      const overlap = Math.min(endMs, to) - Math.max(startMs, from);
      if (overlap > 0) total += overlap / 60_000;
    }
    return total;
  }
}
