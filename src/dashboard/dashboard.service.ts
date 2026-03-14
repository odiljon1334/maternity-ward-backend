import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
    const today = DateUtil.startOfDay(new Date());
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const [
      totalEmployees,
      todayPresent,
      todayAbsent,
      todayLate,
      departments,
      weekStart,
    ] = await Promise.all([
      this.prisma.employee.count({ where: { firedAt: null } }),
      this.prisma.attendanceRecord.count({
        where: { workDate: today, status: { in: ['PRESENT', 'LATE', 'LATE_EARLY', 'EARLY_LEAVE'] } },
      }),
      this.prisma.attendanceRecord.count({ where: { workDate: today, status: 'ABSENT' } }),
      this.prisma.attendanceRecord.count({
        where: { workDate: today, status: { in: ['LATE', 'LATE_EARLY'] } },
      }),
      this.prisma.department.findMany({
        include: { _count: { select: { employees: true } } },
      }),
      DateUtil.startOfWeek(new Date()),
    ]);

    const weeklyDeductions = await this.prisma.weeklyAttendanceStat.aggregate({
      where: { weekStart },
      _sum: { deductionAmount: true },
    });

    const monthlyPayroll = await this.prisma.payrollRecord.aggregate({
      where: { month, year },
      _sum: { netSalary: true, baseSalary: true },
      _count: { id: true },
    });

    return {
      today: {
        date: today,
        totalScheduled: todayPresent + todayAbsent,
        present: todayPresent,
        absent: todayAbsent,
        late: todayLate,
        attendanceRate: todayPresent + todayAbsent > 0
          ? Math.round((todayPresent / (todayPresent + todayAbsent)) * 100)
          : 0,
      },
      employees: {
        total: totalEmployees,
        byDepartment: departments.map(d => ({
          id: d.id,
          name: d.name,
          count: d._count.employees,
        })),
      },
      payroll: {
        month,
        year,
        calculated: monthlyPayroll._count.id,
        totalNet: Number(monthlyPayroll._sum.netSalary || 0),
        totalBase: Number(monthlyPayroll._sum.baseSalary || 0),
        weeklyDeductions: Number(weeklyDeductions._sum.deductionAmount || 0),
      },
    };
  }

  async getAttendanceTrend(days = 30) {
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const records = await this.prisma.attendanceRecord.groupBy({
      by: ['workDate', 'status'],
      where: { workDate: { gte: start } },
      _count: { status: true },
      orderBy: { workDate: 'asc' },
    });

    // Group by date
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

  async getDepartmentStats(month: number, year: number) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    const depts = await this.prisma.department.findMany({
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
      const present = allRecords.filter(r => r.status !== 'ABSENT').length;
      const absent = allRecords.filter(r => r.status === 'ABSENT').length;
      const late = allRecords.filter(r => ['LATE', 'LATE_EARLY'].includes(r.status)).length;

      return {
        department: { id: d.id, name: d.name },
        employeeCount: d.employees.length,
        present,
        absent,
        late,
        attendanceRate: present + absent > 0 ? Math.round((present / (present + absent)) * 100) : 0,
      };
    });
  }

  async getTopLateEmployees(month: number, year: number, limit = 10) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    const stats = await this.prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: {
        workDate: { gte: start, lte: end },
        lateMinutes: { gt: 0 },
      },
      _sum: { lateMinutes: true },
      orderBy: { _sum: { lateMinutes: 'desc' } },
      take: limit,
    });

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: stats.map(s => s.employeeId) } },
      include: { department: true, position: true },
    });

    return stats.map(s => ({
      employee: employees.find(e => e.id === s.employeeId),
      totalLateMin: s._sum.lateMinutes,
    }));
  }
}
