import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { LATE_GRACE_MINUTES, WEEKLY_LATE_THRESHOLD_MIN } from '../common/constants';
import { AttendanceStatus } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

export interface HikvisionEvent {
  employeeNo: string;
  deviceId?: string;
  eventTime?: string;
  raw?: any;
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────
  // HIKVISION WEBHOOK — asosiy check-in/out
  // ──────────────────────────────────────────
  async processHikvisionEvent(event: HikvisionEvent): Promise<{
    employee: any;
    action: 'CHECK_IN' | 'CHECK_OUT';
    attendance: any;
  } | null> {
    const { employeeNo, deviceId, eventTime } = event;

    const employee = await this.prisma.employee.findUnique({
      where: { employeeNo },
      include: { department: true, position: true },
    });

    if (!employee) {
      this.logger.warn(`Unknown employee: ${employeeNo}`);
      return null;
    }

    const eventDate = DateUtil.parseTerminalTime(eventTime);
    const workDate = DateUtil.startOfDay(eventDate);
    const tzDate = dayjs(eventDate).tz(TZ);

    // Find today's schedule for this employee
    // For night shift, check yesterday's schedule too (overnight)
    const schedule = await this.findTodaySchedule(employee.id, workDate, tzDate);

    let attendance = await this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId: employee.id,
        workDate,
      },
    });

    let action: 'CHECK_IN' | 'CHECK_OUT';

    if (!attendance) {
      // First event of the day = CHECK_IN
      action = 'CHECK_IN';
      const expectedCheckIn = schedule
        ? DateUtil.buildDateTime(workDate, schedule.shift!.startTime)
        : workDate;
      const expectedCheckOut = schedule
        ? this.buildExpectedCheckOut(schedule, workDate)
        : new Date(workDate.getTime() + 12 * 3600 * 1000);

      const lateMinutes = this.calcLateMinutes(eventDate, expectedCheckIn, schedule?.shift?.graceMinutes || LATE_GRACE_MINUTES);
      const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

      attendance = await this.prisma.attendanceRecord.create({
        data: {
          employeeId: employee.id,
          scheduleId: schedule?.id,
          deviceId,
          rawCheckInTime: eventDate,
          checkIn: eventDate,
          expectedCheckIn,
          expectedCheckOut,
          workDate,
          status,
          lateMinutes,
        },
      });

      // Update weekly stats
      await this.updateWeeklyStats(employee.id, eventDate, lateMinutes, 0, 0);
    } else {
      // Subsequent event = CHECK_OUT (update)
      action = 'CHECK_OUT';
      const earlyLeaveMin = this.calcEarlyLeaveMinutes(eventDate, attendance.expectedCheckOut);
      const overtimeMinutes = this.calcOvertimeMinutes(eventDate, attendance.expectedCheckOut);

      // Recalculate status
      let status: AttendanceStatus = attendance.status;
      if (attendance.lateMinutes > 0 && earlyLeaveMin > 0) status = 'LATE_EARLY';
      else if (earlyLeaveMin > 0) status = 'EARLY_LEAVE';

      attendance = await this.prisma.attendanceRecord.update({
        where: { id: attendance.id },
        data: {
          rawCheckOutTime: eventDate,
          checkOut: eventDate,
          earlyLeaveMin,
          overtimeMinutes,
          status,
        },
      });

      // Update weekly stats for early leave & overtime
      await this.updateWeeklyStats(employee.id, eventDate, 0, earlyLeaveMin, overtimeMinutes);
    }

    // Link to schedule if not already linked
    if (schedule && !attendance.scheduleId) {
      await this.prisma.attendanceRecord.update({
        where: { id: attendance.id },
        data: { scheduleId: schedule.id },
      });
    }

    return { employee, action, attendance };
  }

  // ──────────────────────────────────────────
  // GET attendance for employee
  // ──────────────────────────────────────────
  async getEmployeeAttendance(employeeId: string, month: number, year: number) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, workDate: { gte: start, lte: end } },
      include: { schedule: { include: { shift: true } } },
      orderBy: { workDate: 'asc' },
    });

    const stats = {
      totalDays: records.length,
      present: records.filter(r => r.status === 'PRESENT').length,
      late: records.filter(r => ['LATE', 'LATE_EARLY'].includes(r.status)).length,
      absent: records.filter(r => r.status === 'ABSENT').length,
      earlyLeave: records.filter(r => ['EARLY_LEAVE', 'LATE_EARLY'].includes(r.status)).length,
      totalLateMin: records.reduce((s, r) => s + r.lateMinutes, 0),
      totalOvertimeMin: records.reduce((s, r) => s + r.overtimeMinutes, 0),
    };

    return { records, stats };
  }

  // ──────────────────────────────────────────
  // GET daily attendance (all employees)
  // ──────────────────────────────────────────
  async getDailyAttendance(date: string) {
    const workDate = DateUtil.startOfDay(date);
    return this.prisma.attendanceRecord.findMany({
      where: { workDate },
      include: {
        employee: { include: { department: true, position: true } },
        schedule: { include: { shift: true } },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
  }

  // ──────────────────────────────────────────
  // GET weekly attendance stats
  // ──────────────────────────────────────────
  async getWeeklyStats(employeeId: string, weekStart: string) {
    const start = DateUtil.startOfWeek(weekStart);
    return this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: start } },
    });
  }

  // ──────────────────────────────────────────
  // MANUAL CHECK-IN (admin override)
  // ──────────────────────────────────────────
  async manualCheckIn(employeeId: string, checkInTime: string, note?: string) {
    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    const eventDate = new Date(checkInTime);
    const workDate = DateUtil.startOfDay(eventDate);

    const schedule = await this.findTodaySchedule(employeeId, workDate, dayjs(eventDate).tz(TZ));
    const expectedCheckIn = schedule
      ? DateUtil.buildDateTime(workDate, schedule.shift!.startTime)
      : workDate;
    const expectedCheckOut = schedule
      ? this.buildExpectedCheckOut(schedule, workDate)
      : new Date(workDate.getTime() + 12 * 3600 * 1000);

    const lateMinutes = this.calcLateMinutes(eventDate, expectedCheckIn, LATE_GRACE_MINUTES);

    return this.prisma.attendanceRecord.upsert({
      where: {
        id: (await this.prisma.attendanceRecord.findFirst({
          where: { employeeId, workDate },
          select: { id: true },
        }))?.id || 'not-found',
      },
      update: { checkIn: eventDate, lateMinutes, note },
      create: {
        employeeId,
        scheduleId: schedule?.id,
        checkIn: eventDate,
        expectedCheckIn,
        expectedCheckOut,
        workDate,
        status: lateMinutes > 0 ? 'LATE' : 'PRESENT',
        lateMinutes,
        note,
      },
    });
  }

  // ──────────────────────────────────────────
  // MARK ABSENT for employees without attendance
  // Run by cron at end of day
  // ──────────────────────────────────────────
  async markAbsentForToday() {
    const workDate = DateUtil.startOfDay(new Date());

    const scheduledToday = await this.prisma.schedule.findMany({
      where: { date: workDate, status: 'WORKING' },
      select: { id: true, employeeId: true, shiftId: true, shift: true },
    });

    let marked = 0;
    for (const sch of scheduledToday) {
      const existing = await this.prisma.attendanceRecord.findFirst({
        where: { employeeId: sch.employeeId, workDate },
      });

      if (!existing && sch.shift) {
        const expectedCheckIn = DateUtil.buildDateTime(workDate, sch.shift.startTime);
        const expectedCheckOut = this.buildExpectedCheckOut(sch as any, workDate);

        await this.prisma.attendanceRecord.create({
          data: {
            employeeId: sch.employeeId,
            scheduleId: sch.id,
            expectedCheckIn,
            expectedCheckOut,
            workDate,
            status: 'ABSENT',
          },
        });
        marked++;
      }
    }

    return { marked };
  }

  // ──────────────────────────────────────────
  // PRIVATE HELPERS
  // ──────────────────────────────────────────

  private async findTodaySchedule(employeeId: string, workDate: Date, eventTz: dayjs.Dayjs) {
    // Try today's schedule first
    let schedule = await this.prisma.schedule.findUnique({
      where: { employeeId_date: { employeeId, date: workDate } },
      include: { shift: true },
    });

    // For night shift: if it's before 10am, check yesterday's schedule
    if (!schedule && eventTz.hour() < 10) {
      const yesterday = DateUtil.startOfDay(dayjs(workDate).subtract(1, 'day').toDate());
      const ySch = await this.prisma.schedule.findUnique({
        where: { employeeId_date: { employeeId, date: yesterday } },
        include: { shift: true },
      });
      if (ySch?.shift?.isOvernight) schedule = ySch;
    }

    return schedule?.status === 'WORKING' ? schedule : null;
  }

  private buildExpectedCheckOut(schedule: any, workDate: Date): Date {
    if (!schedule?.shift) return new Date(workDate.getTime() + 12 * 3600 * 1000);
    const shift = schedule.shift;
    if (shift.isOvernight) {
      // Night shift: ends next day
      const nextDay = dayjs(workDate).add(1, 'day').toDate();
      return DateUtil.buildDateTime(nextDay, shift.endTime);
    }
    return DateUtil.buildDateTime(workDate, shift.endTime);
  }

  /**
   * Kechikish minutlari (grace period dan keyin)
   * 15 minutgacha — 0 qaytaradi
   */
  private calcLateMinutes(checkIn: Date, expected: Date, graceMin: number): number {
    const diff = DateUtil.diffMinutes(checkIn, expected);
    if (diff <= graceMin) return 0;
    return diff - graceMin;
  }

  /**
   * Erta ketish minutlari
   */
  private calcEarlyLeaveMinutes(checkOut: Date, expectedEnd: Date): number {
    const diff = DateUtil.diffMinutes(expectedEnd, checkOut);
    return Math.max(0, diff);
  }

  /**
   * Overtime minutlari (expected vaqtdan keyin)
   */
  private calcOvertimeMinutes(checkOut: Date, expectedEnd: Date): number {
    const diff = DateUtil.diffMinutes(checkOut, expectedEnd);
    return Math.max(0, diff);
  }

  /**
   * Haftalik statistikani yangilash
   * ≥ 120 min kechikish bo'lsa maoshdan kesish hisoblash
   */
  private async updateWeeklyStats(
    employeeId: string,
    date: Date,
    addLateMin: number,
    addEarlyMin: number,
    addOvertime: number,
  ) {
    const weekStart = DateUtil.startOfWeek(date);
    const weekEnd = DateUtil.endOfWeek(date);

    const existing = await this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart } },
    });

    const prevLate = existing?.totalLateMin || 0;
    const newLate = prevLate + addLateMin;
    const penaltyLateMin = Math.max(0, newLate - WEEKLY_LATE_THRESHOLD_MIN);

    // Calculate deduction amount
    let deductionAmount = 0;
    if (penaltyLateMin > 0) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { baseSalary: true },
      });
      if (emp) {
        const monthWorkMinutes = 26 * 12 * 60; // ~26 ish kuni * 12 soat
        const minuteRate = Number(emp.baseSalary) / monthWorkMinutes;
        const addedPenalty = penaltyLateMin - (existing?.penaltyLateMin || 0);
        deductionAmount = (existing ? Number(existing.deductionAmount) : 0) + addedPenalty * minuteRate;
      }
    }

    await this.prisma.weeklyAttendanceStat.upsert({
      where: { employeeId_weekStart: { employeeId, weekStart } },
      update: {
        totalLateMin: { increment: addLateMin },
        totalEarlyMin: { increment: addEarlyMin },
        totalOvertime: { increment: addOvertime },
        penaltyLateMin,
        deductionAmount,
      },
      create: {
        employeeId,
        weekStart,
        weekEnd,
        totalLateMin: addLateMin,
        totalEarlyMin: addEarlyMin,
        totalOvertime: addOvertime,
        daysWorked: addLateMin > 0 || addEarlyMin > 0 ? 1 : 0,
        penaltyLateMin,
        deductionAmount,
      },
    });
  }
}
