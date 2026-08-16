import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

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
      const date = new Date(year, month - 1, d);
      const dow = date.getDay(); // 0=Sun
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

      const totalWorkDays = emp.attendances.filter(
        (a) => a.status !== 'ABSENT',
      ).length;

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
        if (isWeekend) {
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
        baseSalary: true,
        absenceDeduction: true,
        lateDeduction: true,
        earlyLeaveDeduction: true,
        overtimeBonus: true,
        manualBonus: true,
        manualDeduction: true,
        netSalary: true,
        status: true,
      },
    });
    const payMap = new Map(payrollRecords.map((p) => [p.employeeId, p]));

    // Barcha hodimlar uchun yozuv (payroll bo'lmasa bo'sh qiymatlar bilan)
    const records = employees.map((emp) => ({
      employee: emp,
      ...(payMap.get(emp.id) ?? {
        totalWorkDays: 0,
        totalAbsences: 0,
        totalLateMin: 0,
        baseSalary: emp.baseSalary ?? 0,
        absenceDeduction: 0,
        lateDeduction: 0,
        earlyLeaveDeduction: 0,
        overtimeBonus: 0,
        manualBonus: 0,
        manualDeduction: 0,
        netSalary: emp.baseSalary ?? 0,
        status: 'DRAFT',
      }),
    }));

    const workbook = new ExcelJS.Workbook();
    const monthName = dayjs(`${year}-${month}-01`).format('MMMM YYYY');
    const sheet = workbook.addWorksheet(`${monthName} Maosh`);

    // Header
    const cols = [
      '№',
      'F.I.O',
      "Bo'lim",
      'Lavozim',
      'Ish kunlari',
      "Yo'q kunlari",
      'Kechikish (min)',
      'Asosiy maosh',
      "Yo'qlik kesimi",
      'Kechikish kesimi',
      'Erta ketish kesimi',
      "Qo'shimcha ish bonusi",
      "Qo'shimcha bonus",
      "Qo'shimcha kesim",
      'Jami (netto)',
      'Holat',
    ];

    const headerRow = sheet.addRow([]);
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
      4, 26, 18, 20, 10, 10, 14, 14, 14, 14, 14, 16, 14, 14, 14, 10,
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
            : 'Loyiha';
      const net = Number(r.netSalary);
      totalNet += net;

      const row = sheet.addRow([
        idx + 1,
        r.employee.fullName,
        r.employee.department.name,
        r.employee.position.name,
        r.totalWorkDays,
        r.totalAbsences,
        r.totalLateMin,
        Number(r.baseSalary),
        Number(r.absenceDeduction),
        Number(r.lateDeduction),
        Number(r.earlyLeaveDeduction),
        Number(r.overtimeBonus),
        Number(r.manualBonus),
        Number(r.manualDeduction),
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
        if (colNum >= 8) {
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
      const netCell = row.getCell(15);
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
      totalNet,
      '',
    ]);
    totalRow.getCell(2).font = { bold: true };
    totalRow.getCell(15).font = { bold: true };
    totalRow.getCell(15).numFmt = '#,##0';
    totalRow.getCell(15).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFBBDEFB' },
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

    // Map: employeeId → Map<dateStr, record>
    const recMap = new Map<string, Map<string, (typeof records)[0]>>();
    for (const r of records) {
      const ds = dayjs(r.workDate).format('YYYY-MM-DD');
      if (!recMap.has(r.employeeId)) recMap.set(r.employeeId, new Map());
      recMap.get(r.employeeId)!.set(ds, r);
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
      let came = 0,
        absent = 0,
        late = 0;

      const dayCells = weekDays.map((ds) => {
        const dow = dayjs(ds).day(); // 0=Sun, 6=Sat
        if (dow === 0 || dow === 6) return { val: '○', color: 'FFF5F5F5' };
        const rec = dayMap.get(ds);
        if (!rec) {
          absent++;
          return { val: '—', color: 'FFFFEBEE' };
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
}
