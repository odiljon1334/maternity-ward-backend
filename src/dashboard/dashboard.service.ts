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
      ? (() => { const d = new Date(params.date); d.setHours(0, 0, 0, 0); return d; })()
      : DateUtil.startOfDay(new Date());

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const hospitalFilter = params?.hospitalId ? { hospitalId: params.hospitalId } : {};
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
    const expectedToday = scheduledTodayCount > 0 ? scheduledTodayCount : totalEmployees;
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
      attendanceRate: total > 0 ? Math.round((todayPresentCount / total) * 100) : 0,
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
      if (!byDate[dateStr]) byDate[dateStr] = { date: dateStr, present: 0, absent: 0, late: 0 };
      if (['PRESENT', 'EARLY_LEAVE'].includes(r.status)) byDate[dateStr].present += r._count.status;
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
      const late = allRecords.filter((r) => ['LATE', 'LATE_EARLY'].includes(r.status)).length;
      return {
        department: { id: d.id, name: d.name },
        employeeCount: d.employees.length,
        present, absent, late,
        attendanceRate: present + absent > 0 ? Math.round((present / (present + absent)) * 100) : 0,
      };
    });
  }
}
