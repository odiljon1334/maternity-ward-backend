import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';

// ─── RESPONSE TYPES ───────────────────────────────────────────────────────────

export interface HospitalSummary {
  id: string;
  name: string;
  code: string;
  address: string | null;
  isActive: boolean;
  isBlocked: boolean;

  // Hodimlar
  totalEmployees: number;

  // Bugungi davomat
  todayPresent: number;
  todayAbsent: number;
  todayLate: number;
  todayOnBreak: number; // hozir tushlik/coffeeda
  attendanceRate: number; // % kelganlar/rejada borlar

  // Maosh (joriy oy)
  expectedMonthlySalary: number; // baseSalary lari yig'indisi
  approvedMonthlySalary: number; // tasdiqlangan payroll netSalary yig'indisi
  monthlyFines: number; // bu oy shtraflar (deductionlar yig'indisi)
}

export interface MinistryOverview {
  // Umumiy ko'rsatkichlar (barcha kasalxonalar)
  totalHospitals: number;
  activeHospitals: number;
  totalEmployees: number;
  todayPresent: number;
  todayAbsent: number;
  todayLate: number;
  attendanceRate: number;
  expectedMonthlySalary: number;
  approvedMonthlySalary: number;
  totalMonthlyFines: number;

  // Har bir kasalxona uchun alohida
  hospitals: HospitalSummary[];

  asOf: string; // so'rov yuborilgan vaqt
}

export interface AbsentEmployee {
  hospitalId: string;
  hospitalName: string;
  employeeId: string;
  fullName: string;
  department: string;
  position: string;
  phone: string | null;
  expectedCheckIn: Date | null;
}

export interface PayrollSummary {
  month: number;
  year: number;
  hospitals: Array<{
    hospitalId: string;
    hospitalName: string;
    employeeCount: number;
    totalBaseSalary: number;
    totalNetSalary: number;
    totalDeductions: number;
    totalBonuses: number;
    paidCount: number;
    approvedCount: number;
    draftCount: number;
  }>;
  totals: {
    totalBaseSalary: number;
    totalNetSalary: number;
    totalDeductions: number;
    totalBonuses: number;
  };
}

// ─── SERVICE ──────────────────────────────────────────────────────────────────

@Injectable()
export class MinistryService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────────────────────────────────────
  // Umumiy ko'rinish — barcha kasalxonalar statistikasi
  // ──────────────────────────────────────────────────────────────────────────────

  async getOverview(date?: string): Promise<MinistryOverview> {
    const today = date
      ? DateUtil.startOfDay(date)
      : DateUtil.startOfDay(new Date());

    const hospitals = await this.prisma.hospital.findMany({
      orderBy: { name: 'asc' },
    });

    // Barcha kasalxonalar uchun parallel statistika so'rovi
    const summaries = await Promise.all(
      hospitals.map((h) => this.buildHospitalSummary(h, today)),
    );

    // Umumiy ko'rsatkichlar
    const totals = summaries.reduce(
      (acc, h) => {
        acc.totalEmployees += h.totalEmployees;
        acc.todayPresent += h.todayPresent;
        acc.todayAbsent += h.todayAbsent;
        acc.todayLate += h.todayLate;
        acc.expectedMonthlySalary += h.expectedMonthlySalary;
        acc.approvedMonthlySalary += h.approvedMonthlySalary;
        acc.totalMonthlyFines += h.monthlyFines;
        return acc;
      },
      {
        totalEmployees: 0,
        todayPresent: 0,
        todayAbsent: 0,
        todayLate: 0,
        expectedMonthlySalary: 0,
        approvedMonthlySalary: 0,
        totalMonthlyFines: 0,
      },
    );

    const total = totals.todayPresent + totals.todayAbsent;
    const attendanceRate =
      total > 0 ? Math.round((totals.todayPresent / total) * 100) : 0;

    return {
      totalHospitals: hospitals.length,
      activeHospitals: hospitals.filter((h) => h.isActive && !h.isBlocked)
        .length,
      ...totals,
      attendanceRate,
      hospitals: summaries,
      asOf: new Date().toISOString(),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Bitta kasalxona uchun to'liq statistika
  // ──────────────────────────────────────────────────────────────────────────────

  async getHospitalDetail(hospitalId: string, date?: string) {
    const today = date
      ? DateUtil.startOfDay(date)
      : DateUtil.startOfDay(new Date());
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const hospital = await this.prisma.hospital.findUniqueOrThrow({
      where: { id: hospitalId },
    });

    const [summary, absentList, departmentStats, recentAttendance, topLate] =
      await Promise.all([
        this.buildHospitalSummary(hospital, today),
        this.getAbsentEmployees(today, hospitalId),
        this.getDepartmentBreakdown(hospitalId, today),
        this.prisma.attendanceRecord.findMany({
          where: { workDate: today, employee: { hospitalId } },
          include: {
            employee: {
              include: { department: true, position: true },
            },
          },
          orderBy: { checkIn: 'desc' },
          take: 50,
        }),
        this.getTopLateThisMonth(hospitalId, month, year, 10),
      ]);

    return {
      hospital,
      summary,
      absentList,
      departmentStats,
      recentAttendance: recentAttendance.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        fullName: r.employee.fullName,
        photoUrl: (r.employee as any).photoUrl ?? null,
        department: r.employee.department.name,
        position: r.employee.position.name,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        lunchOut: r.lunchOut,
        lunchIn: r.lunchIn,
        coffeeOut: (r as any).coffeeOut ?? null,
        coffeeIn: (r as any).coffeeIn ?? null,
        status: r.status,
        lateMinutes: r.lateMinutes,
      })),
      topLate,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Bugun kelmagan xodimlar (barcha yoki bitta kasalxona)
  // ──────────────────────────────────────────────────────────────────────────────

  async getAbsentToday(
    hospitalId?: string,
    date?: string,
  ): Promise<AbsentEmployee[]> {
    const today = date
      ? DateUtil.startOfDay(date)
      : DateUtil.startOfDay(new Date());
    return this.getAbsentEmployees(today, hospitalId);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Oylik maosh xulosasi
  // ──────────────────────────────────────────────────────────────────────────────

  async getPayrollSummary(
    month: number,
    year: number,
  ): Promise<PayrollSummary> {
    const hospitals = await this.prisma.hospital.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    const hospitalStats = await Promise.all(
      hospitals.map(async (h) => {
        const [payrolls, employees] = await Promise.all([
          this.prisma.payrollRecord.findMany({
            where: { employee: { hospitalId: h.id }, month, year },
            select: {
              status: true,
              baseSalary: true,
              netSalary: true,
              absenceDeduction: true,
              lateDeduction: true,
              earlyLeaveDeduction: true,
              manualDeduction: true,
              manualBonus: true,
              overtimeBonus: true,
            },
          }),
          this.prisma.employee.count({
            where: { hospitalId: h.id, firedAt: null },
          }),
        ]);

        const totalBaseSalary = payrolls.reduce(
          (s, p) => s + Number(p.baseSalary),
          0,
        );
        const totalNetSalary = payrolls.reduce(
          (s, p) => s + Number(p.netSalary),
          0,
        );
        const totalDeductions = payrolls.reduce(
          (s, p) =>
            s +
            Number(p.absenceDeduction) +
            Number(p.lateDeduction) +
            Number(p.earlyLeaveDeduction) +
            Number(p.manualDeduction),
          0,
        );
        const totalBonuses = payrolls.reduce(
          (s, p) => s + Number(p.manualBonus) + Number(p.overtimeBonus),
          0,
        );

        return {
          hospitalId: h.id,
          hospitalName: h.name,
          employeeCount: employees,
          totalBaseSalary,
          totalNetSalary,
          totalDeductions,
          totalBonuses,
          paidCount: payrolls.filter((p) => p.status === 'PAID').length,
          approvedCount: payrolls.filter((p) => p.status === 'APPROVED').length,
          draftCount: payrolls.filter((p) => p.status === 'DRAFT').length,
        };
      }),
    );

    const totals = hospitalStats.reduce(
      (acc, h) => {
        acc.totalBaseSalary += h.totalBaseSalary;
        acc.totalNetSalary += h.totalNetSalary;
        acc.totalDeductions += h.totalDeductions;
        acc.totalBonuses += h.totalBonuses;
        return acc;
      },
      {
        totalBaseSalary: 0,
        totalNetSalary: 0,
        totalDeductions: 0,
        totalBonuses: 0,
      },
    );

    return { month, year, hospitals: hospitalStats, totals };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Bitta kasalxona uchun HospitalSummary quradi.
   * Barcha so'rovlar parallel bajariladi.
   */
  private async buildHospitalSummary(
    hospital: {
      id: string;
      name: string;
      code: string;
      address: string | null;
      isActive: boolean;
      isBlocked: boolean;
    },
    today: Date,
  ): Promise<HospitalSummary> {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const [
      totalEmployees,
      presentCount,
      lateCount,
      onBreakCount,
      scheduledCount,
      expectedSalary,
      approvedPayroll,
      monthlyFinesAgg,
    ] = await Promise.all([
      // Jami aktiv xodimlar
      this.prisma.employee.count({
        where: { hospitalId: hospital.id, firedAt: null },
      }),

      // Bugun kelganlar (PRESENT | LATE | LATE_EARLY | EARLY_LEAVE)
      this.prisma.attendanceRecord.count({
        where: {
          workDate: today,
          status: { in: ['PRESENT', 'LATE', 'LATE_EARLY', 'EARLY_LEAVE'] },
          employee: { hospitalId: hospital.id },
        },
      }),

      // Bugun kechikkanlar
      this.prisma.attendanceRecord.count({
        where: {
          workDate: today,
          status: { in: ['LATE', 'LATE_EARLY'] },
          employee: { hospitalId: hospital.id },
        },
      }),

      // Hozir tushlik/coffeeda (lunchOut bor, lunchIn yo'q)
      this.prisma.attendanceRecord.count({
        where: {
          workDate: today,
          lunchOut: { not: null },
          lunchIn: null,
          employee: { hospitalId: hospital.id },
        },
      }),

      // Bugun rejada bo'lgan xodimlar
      this.prisma.schedule.count({
        where: {
          date: today,
          status: 'WORKING',
          employee: { hospitalId: hospital.id },
        },
      }),

      // Kutilgan oylik — aktiv xodimlar baseSalary yig'indisi
      this.prisma.employee.aggregate({
        where: { hospitalId: hospital.id, firedAt: null },
        _sum: { baseSalary: true },
      }),

      // Tasdiqlangan/to'langan oylik
      this.prisma.payrollRecord.aggregate({
        where: {
          employee: { hospitalId: hospital.id },
          month,
          year,
          status: { in: ['APPROVED', 'PAID'] },
        },
        _sum: { netSalary: true },
      }),

      // Bu oy shtraflar (barcha deductionlar yig'indisi)
      this.prisma.payrollRecord.aggregate({
        where: {
          employee: { hospitalId: hospital.id },
          month,
          year,
        },
        _sum: {
          absenceDeduction: true,
          lateDeduction: true,
          earlyLeaveDeduction: true,
          manualDeduction: true,
        },
      }),
    ]);

    // Kelmagan = rejadagilar - kelganlar (agar jadval yo'q bo'lsa: jami - kelgan)
    const expected = scheduledCount > 0 ? scheduledCount : totalEmployees;
    const todayAbsent = Math.max(0, expected - presentCount);
    const total = presentCount + todayAbsent;
    const attendanceRate =
      total > 0 ? Math.round((presentCount / total) * 100) : 0;

    const monthlyFines =
      Number(monthlyFinesAgg._sum.absenceDeduction ?? 0) +
      Number(monthlyFinesAgg._sum.lateDeduction ?? 0) +
      Number(monthlyFinesAgg._sum.earlyLeaveDeduction ?? 0) +
      Number(monthlyFinesAgg._sum.manualDeduction ?? 0);

    return {
      id: hospital.id,
      name: hospital.name,
      code: hospital.code,
      address: hospital.address,
      isActive: hospital.isActive,
      isBlocked: hospital.isBlocked,
      totalEmployees,
      todayPresent: presentCount,
      todayAbsent,
      todayLate: lateCount,
      todayOnBreak: onBreakCount,
      attendanceRate,
      expectedMonthlySalary: Number(expectedSalary._sum.baseSalary ?? 0),
      approvedMonthlySalary: Number(approvedPayroll._sum.netSalary ?? 0),
      monthlyFines,
    };
  }

  /** Bugun rejada bor, lekin kelmagan xodimlar ro'yxati */
  private async getAbsentEmployees(
    today: Date,
    hospitalId?: string,
  ): Promise<AbsentEmployee[]> {
    const empFilter: any = { firedAt: null };
    if (hospitalId) empFilter.hospitalId = hospitalId;

    // Bugun kelgan xodimlar IDlari
    const presentIds = await this.prisma.attendanceRecord.findMany({
      where: {
        workDate: today,
        status: { in: ['PRESENT', 'LATE', 'LATE_EARLY', 'EARLY_LEAVE'] },
        employee: empFilter,
      },
      select: { employeeId: true },
    });
    const presentSet = new Set(presentIds.map((r) => r.employeeId));

    // Bugun rejada bor, lekin kelmaganlari
    const scheduled = await this.prisma.schedule.findMany({
      where: {
        date: today,
        status: 'WORKING',
        employeeId: { notIn: [...presentSet] },
        employee: empFilter,
      },
      include: {
        shift: true,
        employee: {
          include: {
            department: true,
            position: true,
            hospital: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });

    return scheduled.map((sch) => ({
      hospitalId: sch.employee.hospital.id,
      hospitalName: sch.employee.hospital.name,
      employeeId: sch.employee.id,
      fullName: sch.employee.fullName,
      department: sch.employee.department.name,
      position: sch.employee.position.name,
      phone: sch.employee.phone,
      expectedCheckIn: sch.shift
        ? DateUtil.buildDateTime(today, sch.shift.startTime)
        : null,
    }));
  }

  /** Bo'limlar bo'yicha bugungi davomat */
  private async getDepartmentBreakdown(hospitalId: string, today: Date) {
    const departments = await this.prisma.department.findMany({
      where: { hospitalId },
      include: {
        employees: {
          where: { firedAt: null },
          select: {
            id: true,
            attendances: {
              where: { workDate: today },
              select: { status: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return departments.map((dept) => {
      const records = dept.employees.flatMap((e) => e.attendances);
      const present = records.filter((r) => r.status !== 'ABSENT').length;
      const absent = records.filter((r) => r.status === 'ABSENT').length;
      const late = records.filter((r) =>
        ['LATE', 'LATE_EARLY'].includes(r.status),
      ).length;
      const total = present + absent;
      return {
        id: dept.id,
        name: dept.name,
        employeeCount: dept.employees.length,
        present,
        absent,
        late,
        attendanceRate: total > 0 ? Math.round((present / total) * 100) : 0,
      };
    });
  }

  /** Bu oy eng ko'p kechikkan xodimlar */
  private async getTopLateThisMonth(
    hospitalId: string,
    month: number,
    year: number,
    limit: number,
  ) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    const grouped = await this.prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: {
        workDate: { gte: start, lte: end },
        lateMinutes: { gt: 0 },
        employee: { hospitalId },
      },
      _sum: { lateMinutes: true },
      _count: { employeeId: true },
      orderBy: { _sum: { lateMinutes: 'desc' } },
      take: limit,
    });

    if (!grouped.length) return [];

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: grouped.map((g) => g.employeeId) } },
      include: { department: true },
    });

    return grouped.map((g) => {
      const emp = employees.find((e) => e.id === g.employeeId);
      return {
        employeeId: g.employeeId,
        fullName: emp?.fullName ?? '—',
        department: emp?.department?.name ?? '—',
        lateCount: g._count.employeeId,
        totalLateMin: g._sum.lateMinutes ?? 0,
      };
    });
  }
}
