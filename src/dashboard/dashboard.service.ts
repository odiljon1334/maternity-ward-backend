import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import dayjs from 'dayjs';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Overview ─────────────────────────────────────────────────────────────
  async getOverview(params?: { date?: string; hospitalId?: string }) {
    const today = params?.date
      ? (() => {
          const d = new Date(params.date);
          d.setHours(0, 0, 0, 0);
          return d;
        })()
      : DateUtil.startOfDay(new Date());

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const hospitalFilter = params?.hospitalId
      ? { hospitalId: params.hospitalId }
      : {};
    const empFilter = { firedAt: null, ...hospitalFilter };

    const [
      totalEmployees,
      todayPresentCount,
      todayLateCount,
      todayLunchLateCount,
      monthlyPayroll,
      todayAttendances,
      scheduledTodayCount,
    ] = await Promise.all([
      this.prisma.employee.count({ where: empFilter }),

      this.prisma.attendanceRecord.count({
        where: {
          workDate: today,
          status: { in: ['PRESENT', 'LATE', 'LATE_EARLY', 'EARLY_LEAVE'] },
          employee: empFilter,
        },
      }),

      this.prisma.attendanceRecord.count({
        where: {
          workDate: today,
          status: { in: ['LATE', 'LATE_EARLY'] },
          employee: empFilter,
        },
      }),

      // Bugun tushlikdan kech qaytganlar soni
      this.prisma.attendanceRecord.count({
        where: {
          workDate: today,
          lunchLateMin: { gt: 0 },
          employee: empFilter,
        },
      }),

      this.prisma.payrollRecord.aggregate({
        where: { month, year, employee: { ...hospitalFilter } },
        _sum: { netSalary: true },
      }),

      this.prisma.attendanceRecord.findMany({
        where: { workDate: today, employee: empFilter },
        include: { employee: { include: { department: true } } },
        orderBy: { checkIn: 'asc' },
        take: 50,
      }),

      // Bugun ish rejasi bor hodimlar soni
      this.prisma.schedule.count({
        where: { date: today, status: 'WORKING', employee: empFilter },
      }),
    ]);

    // Kelmagan = bugun rejada bor - kelgan
    // Agar jadval yo'q bo'lsa, jami xodimlar - kelgan
    const expectedToday =
      scheduledTodayCount > 0 ? scheduledTodayCount : totalEmployees;
    const todayAbsentCount = Math.max(0, expectedToday - todayPresentCount);
    const total = todayPresentCount + todayAbsentCount;

    // Bugun rejada bor lekin kelmagan hodimlarni ham qo'shamiz (max 20 ta)
    const attendedIds = new Set(todayAttendances.map((a) => a.employeeId));
    const absentScheduled = await this.prisma.schedule.findMany({
      where: {
        date: today,
        status: 'WORKING',
        employeeId: { notIn: [...attendedIds] },
        employee: empFilter,
      },
      include: { employee: { include: { department: true } } },
      take: 20,
    });

    const absentAttendances = absentScheduled.map((sch) => ({
      id: `absent-${sch.employeeId}`,
      employeeId: sch.employeeId,
      employeeName: sch.employee.fullName,
      photoUrl: (sch.employee as any).photoUrl ?? null,
      department: sch.employee.department?.name ?? '—',
      checkIn: null,
      checkOut: null,
      lunchOut: null,
      lunchIn: null,
      lunchLateMin: 0,
      status: 'ABSENT',
      lateMinutes: 0,
    }));

    return {
      totalEmployees,
      todayPresent: todayPresentCount,
      todayAbsent: todayAbsentCount,
      todayLate: todayLateCount,
      todayLunchLate: todayLunchLateCount,
      attendanceRate:
        total > 0 ? Math.round((todayPresentCount / total) * 100) : 0,
      monthlyPayrollTotal: Number(monthlyPayroll._sum.netSalary || 0),
      todayAttendances: [
        ...todayAttendances.map((a) => ({
          id: a.id,
          employeeId: a.employeeId,
          employeeName: a.employee.fullName,
          photoUrl: (a.employee as any).photoUrl ?? null,
          department: a.employee.department?.name ?? '—',
          checkIn: a.checkIn,
          checkOut: a.checkOut,
          lunchOut: a.lunchOut,
          lunchIn: a.lunchIn,
          lunchLateMin: a.lunchLateMin ?? 0,
          status: a.status,
          lateMinutes: a.lateMinutes ?? 0,
        })),
        ...absentAttendances,
      ],
    };
  }

  // ─── Trend ─────────────────────────────────────────────────────────────────
  async getAttendanceTrend(days = 14, hospitalId?: string) {
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const hospitalFilter = hospitalId ? { employee: { hospitalId } } : {};

    const records = await this.prisma.attendanceRecord.groupBy({
      by: ['workDate', 'status'],
      where: { workDate: { gte: start }, ...hospitalFilter },
      _count: { status: true },
      orderBy: { workDate: 'asc' },
    });

    const byDate: Record<string, any> = {};
    for (const r of records) {
      const dateStr = r.workDate.toISOString().slice(0, 10);
      if (!byDate[dateStr])
        byDate[dateStr] = { date: dateStr, present: 0, absent: 0, late: 0 };
      if (['PRESENT', 'EARLY_LEAVE'].includes(r.status))
        byDate[dateStr].present += r._count.status;
      if (r.status === 'ABSENT') byDate[dateStr].absent += r._count.status;
      if (['LATE', 'LATE_EARLY'].includes(r.status)) {
        byDate[dateStr].late += r._count.status;
        byDate[dateStr].present += r._count.status;
      }
    }

    return Object.values(byDate);
  }

  // ─── Top late ──────────────────────────────────────────────────────────────
  async getTopLateEmployees(limit = 5, hospitalId?: string) {
    const now = new Date();
    const start = DateUtil.startOfMonth(now.getFullYear(), now.getMonth() + 1);
    const end = DateUtil.endOfMonth(now.getFullYear(), now.getMonth() + 1);

    const hospitalFilter = hospitalId ? { hospitalId } : {};

    const stats = await this.prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: {
        workDate: { gte: start, lte: end },
        lateMinutes: { gt: 0 },
        employee: { ...hospitalFilter },
      },
      _sum: { lateMinutes: true },
      _count: { employeeId: true },
      orderBy: { _sum: { lateMinutes: 'desc' } },
      take: limit,
    });

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: stats.map((s) => s.employeeId) } },
      include: { department: true },
    });

    return stats.map((s) => {
      const emp = employees.find((e) => e.id === s.employeeId);
      return {
        employeeId: s.employeeId,
        name: emp?.fullName ?? '—',
        department: emp?.department?.name ?? '—',
        lateCount: s._count.employeeId,
        totalLateMin: s._sum.lateMinutes ?? 0,
      };
    });
  }

  // ─── Department stats ──────────────────────────────────────────────────────
  async getDepartmentStats(month: number, year: number, hospitalId?: string) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);
    const hospitalFilter = hospitalId ? { hospitalId } : {};

    const depts = await this.prisma.department.findMany({
      where: { ...hospitalFilter },
      include: {
        employees: {
          where: { firedAt: null },
          include: {
            attendances: {
              where: { workDate: { gte: start, lte: end } },
            },
          },
        },
      },
    });

    return depts.map((d) => {
      const allRecords = d.employees.flatMap((e) => e.attendances);
      const present = allRecords.filter((r) => r.status !== 'ABSENT').length;
      const absent = allRecords.filter((r) => r.status === 'ABSENT').length;
      const late = allRecords.filter((r) =>
        ['LATE', 'LATE_EARLY'].includes(r.status),
      ).length;
      return {
        department: { id: d.id, name: d.name },
        employeeCount: d.employees.length,
        present,
        absent,
        late,
        attendanceRate:
          present + absent > 0
            ? Math.round((present / (present + absent)) * 100)
            : 0,
      };
    });
  }

  // ─── Analytics: Monthly attendance summary ─────────────────────────────────
  async getMonthlyAttendanceSummary(months = 6, hospitalId?: string) {
    const now = dayjs();
    const result: any[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = now.subtract(i, 'month');
      const m = d.month() + 1;
      const y = d.year();
      const start = DateUtil.startOfMonth(y, m);
      const end = DateUtil.endOfMonth(y, m);

      const hospitalFilter = hospitalId ? { employee: { hospitalId } } : {};

      const records = await this.prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { workDate: { gte: start, lte: end }, ...hospitalFilter },
        _count: { status: true },
      });

      const byStatus: Record<string, number> = {};
      for (const r of records) byStatus[r.status] = r._count.status;

      const present =
        (byStatus['PRESENT'] ?? 0) +
        (byStatus['LATE'] ?? 0) +
        (byStatus['LATE_EARLY'] ?? 0) +
        (byStatus['EARLY_LEAVE'] ?? 0);
      const absent = byStatus['ABSENT'] ?? 0;
      const late = (byStatus['LATE'] ?? 0) + (byStatus['LATE_EARLY'] ?? 0);
      const earlyLeave =
        (byStatus['EARLY_LEAVE'] ?? 0) + (byStatus['LATE_EARLY'] ?? 0);

      result.push({
        month: `${y}-${String(m).padStart(2, '0')}`,
        label: d.format('MMM YYYY'),
        present,
        absent,
        late,
        earlyLeave,
        total: present + absent,
        attendanceRate:
          present + absent > 0
            ? Math.round((present / (present + absent)) * 100)
            : 0,
      });
    }
    return result;
  }

  // ─── Analytics: Employee performance ranking ───────────────────────────────
  async getEmployeePerformanceRanking(
    month: number,
    year: number,
    hospitalId?: string,
    limit = 10,
  ) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);
    const hospitalFilter = hospitalId ? { hospitalId } : {};

    const records = await this.prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: {
        workDate: { gte: start, lte: end },
        employee: { firedAt: null, ...hospitalFilter },
      },
      _count: { employeeId: true },
      _sum: { lateMinutes: true },
    });

    // Per employee, count by status
    const allRecords = await this.prisma.attendanceRecord.findMany({
      where: {
        workDate: { gte: start, lte: end },
        employee: { firedAt: null, ...hospitalFilter },
      },
      select: { employeeId: true, status: true, lateMinutes: true },
    });

    const empMap: Record<
      string,
      {
        present: number;
        absent: number;
        late: number;
        earlyLeave: number;
        totalLateMin: number;
      }
    > = {};
    for (const r of allRecords) {
      if (!empMap[r.employeeId])
        empMap[r.employeeId] = {
          present: 0,
          absent: 0,
          late: 0,
          earlyLeave: 0,
          totalLateMin: 0,
        };
      const e = empMap[r.employeeId];
      if (['PRESENT'].includes(r.status)) e.present++;
      else if (r.status === 'ABSENT') e.absent++;
      else if (['LATE', 'LATE_EARLY'].includes(r.status)) {
        e.late++;
        e.present++;
      } else if (r.status === 'EARLY_LEAVE') {
        e.earlyLeave++;
        e.present++;
      }
      e.totalLateMin += r.lateMinutes ?? 0;
    }

    const empIds = Object.keys(empMap);
    if (empIds.length === 0)
      return { topPerformers: [], mostAbsent: [], mostLate: [] };

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: empIds } },
      include: { department: true },
    });
    const empInfo: Record<string, any> = {};
    for (const e of employees) empInfo[e.id] = e;

    const ranked = empIds.map((id) => {
      const s = empMap[id];
      const emp = empInfo[id];
      const total = s.present + s.absent;
      return {
        employeeId: id,
        name: emp?.fullName ?? '—',
        photoUrl: (emp as any)?.photoUrl ?? null,
        department: emp?.department?.name ?? '—',
        present: s.present,
        absent: s.absent,
        late: s.late,
        earlyLeave: s.earlyLeave,
        totalLateMin: s.totalLateMin,
        attendanceRate: total > 0 ? Math.round((s.present / total) * 100) : 0,
      };
    });

    return {
      topPerformers: [...ranked]
        .sort((a, b) => b.attendanceRate - a.attendanceRate)
        .slice(0, limit),
      mostAbsent: [...ranked]
        .sort((a, b) => b.absent - a.absent)
        .slice(0, limit),
      mostLate: [...ranked]
        .sort((a, b) => b.totalLateMin - a.totalLateMin)
        .slice(0, limit),
    };
  }

  // ─── Analytics: Payroll cost trend ─────────────────────────────────────────
  async getPayrollTrend(months = 6, hospitalId?: string) {
    const now = dayjs();
    const result: any[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = now.subtract(i, 'month');
      const m = d.month() + 1;
      const y = d.year();

      const hospitalFilter = hospitalId ? { employee: { hospitalId } } : {};

      const agg = await this.prisma.payrollRecord.aggregate({
        where: { month: m, year: y, ...hospitalFilter },
        _sum: {
          baseSalary: true,
          netSalary: true,
          absenceDeduction: true,
          lateDeduction: true,
          earlyLeaveDeduction: true,
          manualDeduction: true,
          overtimeBonus: true,
          manualBonus: true,
        },
        _count: { _all: true },
      });

      const totalDeductions =
        Number(agg._sum.absenceDeduction ?? 0) +
        Number(agg._sum.lateDeduction ?? 0) +
        Number(agg._sum.earlyLeaveDeduction ?? 0) +
        Number(agg._sum.manualDeduction ?? 0);

      const totalBonuses =
        Number(agg._sum.overtimeBonus ?? 0) + Number(agg._sum.manualBonus ?? 0);

      result.push({
        month: `${y}-${String(m).padStart(2, '0')}`,
        label: d.format('MMM YYYY'),
        baseSalary: Number(agg._sum.baseSalary ?? 0),
        netSalary: Number(agg._sum.netSalary ?? 0),
        totalDeductions,
        totalBonuses,
        employeeCount: agg._count._all,
      });
    }
    return result;
  }

  // ─── Analytics: Leave statistics ───────────────────────────────────────────
  async getLeaveStats(year: number, hospitalId?: string) {
    const start = new Date(`${year}-01-01T00:00:00`);
    const end = new Date(`${year}-12-31T23:59:59`);
    const hospitalFilter = hospitalId ? { employee: { hospitalId } } : {};

    // By type
    const byType = await this.prisma.leaveRequest.groupBy({
      by: ['type', 'status'],
      where: { startDate: { gte: start, lte: end }, ...hospitalFilter },
      _count: { id: true },
    });

    // By month (approved only)
    const byMonth = await this.prisma.leaveRequest.groupBy({
      by: ['startDate'],
      where: {
        startDate: { gte: start, lte: end },
        status: 'APPROVED',
        ...hospitalFilter,
      },
      _count: { id: true },
    });

    // Aggregate by type
    const typeMap: Record<
      string,
      { pending: number; approved: number; rejected: number; cancelled: number }
    > = {};
    for (const r of byType) {
      if (!typeMap[r.type])
        typeMap[r.type] = {
          pending: 0,
          approved: 0,
          rejected: 0,
          cancelled: 0,
        };
      const st = r.status.toLowerCase() as keyof (typeof typeMap)[string];
      if (st in typeMap[r.type]) typeMap[r.type][st] = r._count.id;
    }

    // Aggregate by month
    const monthMap: Record<string, number> = {};
    for (const r of byMonth) {
      const key = `${r.startDate.getFullYear()}-${String(r.startDate.getMonth() + 1).padStart(2, '0')}`;
      monthMap[key] = (monthMap[key] ?? 0) + r._count.id;
    }

    const monthlyLeaves = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const key = `${year}-${String(m).padStart(2, '0')}`;
      return {
        month: key,
        label: dayjs(`${year}-${String(m).padStart(2, '0')}-01`).format('MMM'),
        count: monthMap[key] ?? 0,
      };
    });

    return {
      byType: Object.entries(typeMap).map(([type, counts]) => ({
        type,
        ...counts,
        total:
          counts.pending + counts.approved + counts.rejected + counts.cancelled,
      })),
      monthlyApproved: monthlyLeaves,
    };
  }

  // ─── Analytics: Check-in time heatmap (hour distribution) ─────────────────
  async getCheckinHeatmap(days = 30, hospitalId?: string) {
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const hospitalFilter = hospitalId ? { employee: { hospitalId } } : {};

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        workDate: { gte: start },
        checkIn: { not: null },
        ...hospitalFilter,
      },
      select: { checkIn: true },
    });

    // Count by hour 0-23
    const hourCounts = new Array(24).fill(0);
    for (const r of records) {
      if (r.checkIn) {
        // Convert to Tashkent time: UTC+5
        const hour = (r.checkIn.getUTCHours() + 5) % 24;
        hourCounts[hour]++;
      }
    }

    return hourCounts.map((count, hour) => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      count,
    }));
  }
}
