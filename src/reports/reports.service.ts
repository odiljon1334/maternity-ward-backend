import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import { AttendanceService } from '../attendance/attendance.service';

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendanceService: AttendanceService,
  ) {}

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
  private static readonly T13_CODES: Record<string, string> = {
    PRESENT: 'Я',
    LATE: 'Я',
    EARLY_LEAVE: 'Я',
    LATE_EARLY: 'Я',
    ABSENT: 'Н',
    DAY_OFF: 'В',
    HOLIDAY: 'В',
    VACATION: 'ОТ',
    SICK: 'Б',
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

    const [employees, hospital] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          firedAt: null,
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

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'StaffPulse (MaternityCare)';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(
      `T-13 ${year}-${String(month).padStart(2, '0')}`,
      { pageSetup: { orientation: 'landscape', fitToPage: true } },
    );

    const monthName = dayjs(`${year}-${month}-01`).format('MMMM YYYY');
    const totalCols = 6 + daysInMonth + 4; // №,FIO,Bo'lim,Lavozim + kunlar + 4 jami ustun

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
      'Я (ish kuni)',
      "ОТ (ta'til)",
      'Б (kasallik)',
      "Н (yo'qlik)",
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
    let rowCursor = codesRowIdx + 1;
    employees.forEach((emp, idx) => {
      const dayMap = new Map<number, { status: string; netWorkMin: number }>();
      attendanceByEmployee[idx].records.forEach((r: any) => {
        dayMap.set(new Date(r.workDate).getDate(), {
          status: r.status,
          netWorkMin: r.netWorkMin ?? 0,
        });
      });

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

      let worked = 0;
      let vacation = 0;
      let sick = 0;
      let absent = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const col = 4 + d;
        const day = dayMap.get(d);
        const code = day ? (ReportsService.T13_CODES[day.status] ?? '') : '';
        codeRow.getCell(col).value = code;
        codeRow.getCell(col).alignment = { horizontal: 'center' };
        codeRow.getCell(col).font = { size: 9 };

        const isWorked =
          day && ReportsService.T13_WORKED_STATUSES.has(day.status);
        hoursRow.getCell(col).value = isWorked
          ? +(day!.netWorkMin / 60).toFixed(1)
          : '';
        hoursRow.getCell(col).alignment = { horizontal: 'center' };
        hoursRow.getCell(col).font = { size: 7, color: { argb: 'FF757575' } };

        if (isWorked) worked++;
        else if (day?.status === 'VACATION') vacation++;
        else if (day?.status === 'SICK') sick++;
        else if (day?.status === 'ABSENT') absent++;
      }

      const totalsCol = 4 + daysInMonth;
      sheet.mergeCells(rowCursor, totalsCol + 1, rowCursor + 1, totalsCol + 1);
      sheet.mergeCells(rowCursor, totalsCol + 2, rowCursor + 1, totalsCol + 2);
      sheet.mergeCells(rowCursor, totalsCol + 3, rowCursor + 1, totalsCol + 3);
      sheet.mergeCells(rowCursor, totalsCol + 4, rowCursor + 1, totalsCol + 4);
      sheet.getCell(rowCursor, totalsCol + 1).value = worked;
      sheet.getCell(rowCursor, totalsCol + 2).value = vacation;
      sheet.getCell(rowCursor, totalsCol + 3).value = sick;
      sheet.getCell(rowCursor, totalsCol + 4).value = absent;
      [1, 2, 3, 4].forEach((i) => {
        const cell = sheet.getCell(rowCursor, totalsCol + i);
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true };
      });

      if (idx % 2 === 0) {
        for (let c = 1; c <= totalsCol + 4; c++) {
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
      "Я=Yavka (ishladi)  Н=Noma'lum sababli yo'qlik  В=Dam olish/bayram  ОТ=Navbatdagi ta'til  Б=Vaqtinchalik mehnatga layoqatsizlik (kasallik)";

    return workbook.xlsx.writeBuffer() as Promise<ExcelJS.Buffer>;
  }
}
