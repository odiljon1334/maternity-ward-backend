/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { isHospitalBlocked } from '../common/utils/payment.util';
import { OVERTIME_RATE } from '../common/constants';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PushService } from '../push/push.service';

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
  async calculate(employeeId: string, month: number, year: number) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
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
    const workDays = records.filter((r) => r.status !== 'ABSENT').length;
    const absences = records.filter((r) => r.status === 'ABSENT').length;
    const totalLateMin = records.reduce((s, r) => s + r.lateMinutes, 0);
    const totalEarlyMin = records.reduce((s, r) => s + r.earlyLeaveMin, 0);
    const totalOvertimeMin = records.reduce((s, r) => s + r.overtimeMinutes, 0);
    // Sof ish vaqti: checkIn/checkOut bo'lgan kunlardagi netWorkMin yig'indisi
    const totalNetWorkMin = records.reduce(
      (s, r) => s + (r.netWorkMin ?? 0),
      0,
    );

    // Scheduled work days in this month
    const scheduledDays = await this.prisma.schedule.count({
      where: {
        employeeId,
        date: { gte: start, lte: end },
        status: 'WORKING',
      },
    });

    const dailyRate = scheduledDays > 0 ? baseSalary / scheduledDays : 0;
    const minuteRate =
      scheduledDays > 0 ? baseSalary / (scheduledDays * 12 * 60) : 0;

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
      baseSalary -
        absenceDeduction -
        lateDeduction -
        earlyLeaveDeduction +
        overtimeBonus,
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

    // scheduledDays, employeeId, month, year — DB modelida yo'q yoki where clause da
    const {
      scheduledDays: _s,
      employeeId: _e,
      month: _m,
      year: _y,
      netSalary: _n,
      ...dbFields
    } = preview;

    // Mavjud yozuv statusini tekshiramiz — APPROVED/PAID bo'lsa status ni o'zgartirmaymiz
    const existing = await this.prisma.payrollRecord.findUnique({
      where: { employeeId_month_year: { employeeId, month, year } },
      select: { status: true, manualBonus: true, manualDeduction: true },
    });

    const keepStatus =
      existing?.status === 'APPROVED' || existing?.status === 'PAID';
    const finalStatus = keepStatus ? existing!.status : 'DRAFT';

    // APPROVED/PAID bo'lsa manual bonuslarni ham saqlaymiz
    const finalBonus = keepStatus ? Number(existing!.manualBonus) : manualBonus;
    const finalDeduction = keepStatus
      ? Number(existing!.manualDeduction)
      : manualDeduction;
    const finalNet = Math.max(
      0,
      preview.netSalary + finalBonus - finalDeduction,
    );

    return this.prisma.payrollRecord.upsert({
      where: { employeeId_month_year: { employeeId, month, year } },
      update: {
        ...dbFields,
        manualBonus: finalBonus,
        manualDeduction: finalDeduction,
        netSalary: finalNet,
        note,
        status: finalStatus,
      },
      create: {
        employeeId,
        month,
        year,
        ...dbFields,
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

    const where: any = { firedAt: null };
    if (hospitalId) where.hospitalId = hospitalId;
    if (departmentId) where.departmentId = departmentId;

    const employees = await this.prisma.employee.findMany({
      where,
      select: { id: true },
    });

    const results = [];
    const empFull = await this.prisma.employee.findMany({
      where,
      select: { id: true, userId: true },
    });
    const userIdMap: Record<string, string | null> = {};
    for (const e of empFull) userIdMap[e.id] = e.userId;

    for (const emp of employees) {
      try {
        const record = await this.createOrUpdate(emp.id, month, year);
        results.push({
          employeeId: emp.id,
          status: 'ok',
          netSalary: Number(record.netSalary),
        });
        // Push xabarnoma — xodimga maosh hisoblandi
        const uid = userIdMap[emp.id];
        if (uid) {
          this.push
            .notifyPayrollGenerated(uid, month, year, Number(record.netSalary))
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
  async approve(id: string) {
    const record = await this.prisma.payrollRecord.findUnique({
      where: { id },
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

  async findOne(employeeId: string, month: number, year: number) {
    return this.prisma.payrollRecord.findUnique({
      where: { employeeId_month_year: { employeeId, month, year } },
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

    sheet.mergeCells('A1:N1');
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
      { width: 12 },
      { width: 15 },
      { width: 12 },
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
  ): Promise<Buffer> {
    // Fetch saved record first; if not found, calculate on the fly
    const record = await this.prisma.payrollRecord.findUnique({
      where: { employeeId_month_year: { employeeId, month, year } },
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
      emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        include: { department: true, position: true, hospital: true },
      });
      if (!emp) throw new NotFoundException('Xodim topilmadi');
      const { preview } = await this.calculate(employeeId, month, year);
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
    const earlyLeaveDeduction = record
      ? Number(record.earlyLeaveDeduction)
      : previewData.earlyLeaveDeduction;
    const overtimeBonus = record
      ? Number(record.overtimeBonus)
      : previewData.overtimeBonus;
    const manualBonus = record ? Number(record.manualBonus) : 0;
    const manualDeduction = record ? Number(record.manualDeduction) : 0;
    const netSalary = record ? Number(record.netSalary) : previewData.netSalary;
    const status = record?.status ?? 'PREVIEW';
    const hospitalName = (emp.hospital as any)?.name ?? "Tug'ruqxona";

    const totalDeductions =
      absenceDeduction + lateDeduction + earlyLeaveDeduction + manualDeduction;
    const totalBonuses = overtimeBonus + manualBonus;

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
      drawSection('KESIMLAR (CHEGIRMALAR)', [
        {
          label: "Yo'qlik uchun kesim",
          value: totalDeductions > 0 ? `− ${fmtMoney(absenceDeduction)}` : '—',
          color: absenceDeduction > 0 ? COLORS.danger : undefined,
        },
        {
          label: 'Kechikish uchun kesim',
          value: lateDeduction > 0 ? `− ${fmtMoney(lateDeduction)}` : '—',
          color: lateDeduction > 0 ? COLORS.danger : undefined,
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
          label: "Qo'lda kesim",
          value: manualDeduction > 0 ? `− ${fmtMoney(manualDeduction)}` : '—',
          color: manualDeduction > 0 ? COLORS.danger : undefined,
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
        { label: 'Kechikish (soat)', value: fmtMin(totalLateMin) },
        { label: 'Erta ketish', value: fmtMin(totalEarlyMin) },
        { label: 'Overtime', value: fmtMin(totalOvertimeMin) },
        {
          label: "Qo'lda bonus",
          value: manualBonus > 0 ? `+ ${fmtMoney(manualBonus)}` : '—',
          color: manualBonus > 0 ? COLORS.success : undefined,
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
