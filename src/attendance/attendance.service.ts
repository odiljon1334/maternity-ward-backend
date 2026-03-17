import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { isHospitalBlocked } from '../common/utils/payment.util';
import { LATE_GRACE_MINUTES, WEEKLY_LATE_THRESHOLD_MIN } from '../common/constants';
import { AttendanceStatus } from '@prisma/client';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

// Ikkinchi scan CHECK_OUT bo'lishi uchun minimum vaqt (daqiqa)
// 120 daqiqa = 2 soat. Agar check-in dan 2 soat o'tmagan bo'lsa, scan ignore qilinadi
const MIN_CHECKOUT_GAP_MIN = 120;

// Tushlik vaqtini aniqlash oynasi (minutlarda): ±45 min
const LUNCH_WINDOW_MIN = 45;

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

    // Kasalxona to'lovi OVERDUE bo'lsa — davomat yozilmaydi
    if (await isHospitalBlocked(this.prisma, employee.hospitalId)) {
      this.logger.warn(`Hospital ${employee.hospitalId} is BLOCKED (overdue payment). Skipping attendance for ${employee.fullName}`);
      return null;
    }

    const eventDate = DateUtil.parseTerminalTime(eventTime);
    const workDate = DateUtil.startOfDay(eventDate);
    const tzDate = dayjs(eventDate).tz(TZ);

    // Find today's schedule for this employee
    // For night shift, check yesterday's schedule too (overnight)
    const schedule = await this.findTodaySchedule(employee.id, workDate, tzDate);

    // Fallback: if no schedule, use hospital's shift template matching event time
    const fallbackShift = !schedule
      ? await this.findFallbackShift(employee.hospitalId, tzDate)
      : null;

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
      const expectedCheckIn = (schedule?.shift)
        ? DateUtil.buildDateTime(workDate, schedule.shift.startTime)
        : fallbackShift
          ? DateUtil.buildDateTime(workDate, fallbackShift.startTime)
          : DateUtil.buildDateTime(workDate, '08:00'); // default 08:00
      const expectedCheckOut = schedule
        ? this.buildExpectedCheckOut(schedule, workDate)
        : fallbackShift
          ? (fallbackShift.isOvernight
              ? DateUtil.buildDateTime(dayjs(workDate).add(1, 'day').toDate(), fallbackShift.endTime)
              : DateUtil.buildDateTime(workDate, fallbackShift.endTime))
          : new Date(workDate.getTime() + 12 * 3600 * 1000);

      const graceMin = schedule?.shift?.graceMinutes ?? fallbackShift?.graceMinutes ?? LATE_GRACE_MINUTES;
      const lateMinutes = this.calcLateMinutes(eventDate, expectedCheckIn, graceMin);
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
      // ── Keyingi scan — tushlik yoki check-out ──────────────────────────────

      const shift = schedule?.shift || fallbackShift;

      // 0. Agar checkOut allaqachon yozilgan bo'lsa → butunlay ignore qil.
      //    (Ish tugagandan keyin terminal qayta scan yuborsa yoki xodim
      //     ofisga qaytsa — qo'shimcha ish vaqti hisoblanmasin, Telegram yuborilmasin)
      if (attendance.checkOut) {
        this.logger.log(
          `Post-checkout scan ignored for ${employee.fullName} — already checked out at ${attendance.checkOut.toISOString()}`,
        );
        return null;
      }

      // 1. Tushlik chiqish: check-in bor, lunchOut yo'q, shift da lunchStart bor,
      //    VA scan vaqti tushlik oynasida (lunchStart ± LUNCH_WINDOW_MIN)
      //    LEKIN: agar checkIn dan MIN_CHECKOUT_GAP_MIN o'tgan bo'lsa — bu checkout,
      //    tushlik oynasida bo'lsa ham. (Erta ketish holati)
      const gapFromCheckIn = DateUtil.diffMinutes(eventDate, attendance.checkIn!);
      const canBeCheckout = gapFromCheckIn >= MIN_CHECKOUT_GAP_MIN;

      if (!attendance.lunchOut && shift?.lunchStart && !canBeCheckout) {
        if (this.isNearLunchStart(eventDate, shift.lunchStart)) {
          await this.prisma.attendanceRecord.update({
            where: { id: attendance.id },
            data: { lunchOut: eventDate },
          });
          this.logger.log(`Lunch OUT: ${employee.fullName} at ${eventDate.toISOString()}`);
          return null; // tushlik chiqish uchun Telegram xabar yuborilmaydi
        }
      }

      // 2. Tushlikdan qaytish: lunchOut bor, lunchIn yo'q
      if (attendance.lunchOut && !attendance.lunchIn) {
        const lunchLateMin = shift
          ? this.calcLunchLateMinutes(eventDate, shift.lunchEnd, shift.lunchGraceMin)
          : 0;

        const newLateMin = attendance.lateMinutes + lunchLateMin;
        let newStatus: AttendanceStatus = attendance.status;
        if (newLateMin > 0) {
          newStatus = attendance.earlyLeaveMin > 0 ? 'LATE_EARLY' : 'LATE';
        }

        await this.prisma.attendanceRecord.update({
          where: { id: attendance.id },
          data: {
            lunchIn: eventDate,
            lunchLateMin,
            lateMinutes: newLateMin,
            status: newStatus,
          },
        });

        if (lunchLateMin > 0) {
          await this.updateWeeklyStats(employee.id, eventDate, lunchLateMin, 0, 0);
          this.logger.log(`Lunch LATE ${lunchLateMin}min: ${employee.fullName}`);
        } else {
          this.logger.log(`Lunch IN (on time): ${employee.fullName}`);
        }
        return null; // tushlikdan qaytish uchun ham Telegram yuborilmaydi
      }

      // 3. CHECK_OUT — gap ni lunchIn (agar bor) yoki checkIn dan hisoblash
      //    Agar 2 soat o'tmagan bo'lsa — terminal dublikatini ignore qil
      const gapFrom = attendance.lunchIn ?? attendance.checkIn!;
      const gapMin = attendance.lunchIn
        ? DateUtil.diffMinutes(eventDate, attendance.lunchIn)
        : gapFromCheckIn;

      if (gapMin < MIN_CHECKOUT_GAP_MIN) {
        this.logger.log(
          `Duplicate/early scan ignored for ${employee.fullName}: gap=${gapMin}min < ${MIN_CHECKOUT_GAP_MIN}min`,
        );
        return null;
      }

      action = 'CHECK_OUT';

      // Lunch orasidagi vaqt (lunchOut → lunchIn) ish vaqtidan tashqari.
      // expectedCheckOut allaqachon shift.endTime ga asoslangan, shuning uchun
      // earlyLeave va overtime hisobida lunch orasini ayirishga hojat yo'q —
      // lekin lunchLateMin orqali kechikish allaqachon lateMinutes ga qo'shilgan.
      const earlyLeaveMin = this.calcEarlyLeaveMinutes(eventDate, attendance.expectedCheckOut);
      const overtimeMinutes = this.calcOvertimeMinutes(eventDate, attendance.expectedCheckOut);

      // Status qayta hisoblash
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

      // Haftalik statistika yangilash
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
  async getDailyAttendance(date: string, departmentId?: string, hospitalId?: string) {
    const workDate = DateUtil.startOfDay(date);

    // Build employee filter
    const empFilter: any = { firedAt: null };
    if (hospitalId) empFilter.hospitalId = hospitalId;
    if (departmentId) empFilter.departmentId = departmentId;

    // 1. Actual attendance records (kelgan/kechikkan/ketgan hodimlar)
    const records = await this.prisma.attendanceRecord.findMany({
      where: { workDate, employee: empFilter },
      include: {
        employee: { include: { department: true, position: true } },
        schedule: { include: { shift: true } },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });

    // 2. Bugun ish rejasi bor, lekin kelmagan hodimlar (virtual ABSENT)
    const attendedIds = new Set(records.map((r) => r.employeeId));

    const scheduledMissing = await this.prisma.schedule.findMany({
      where: {
        date: workDate,
        status: 'WORKING',
        employeeId: { notIn: [...attendedIds] },
        employee: empFilter,
      },
      include: {
        shift: true,
        employee: { include: { department: true, position: true } },
      },
    });

    // Virtual ABSENT record (DB ga yozilmaydi, faqat response uchun)
    const absentVirtual = scheduledMissing.map((sch) => {
      const expectedCheckIn = sch.shift
        ? DateUtil.buildDateTime(workDate, sch.shift.startTime)
        : new Date(workDate.getTime() + 8 * 3600 * 1000);
      const expectedCheckOut = sch.shift
        ? (sch.shift.isOvernight
            ? DateUtil.buildDateTime(dayjs(workDate).add(1, 'day').toDate(), sch.shift.endTime)
            : DateUtil.buildDateTime(workDate, sch.shift.endTime))
        : new Date(workDate.getTime() + 20 * 3600 * 1000);
      return {
        id: `absent-${sch.employeeId}`,
        employeeId: sch.employeeId,
        scheduleId: sch.id,
        deviceId: null,
        rawCheckInTime: null,
        rawCheckOutTime: null,
        checkIn: null,
        checkOut: null,
        expectedCheckIn,
        expectedCheckOut,
        status: 'ABSENT' as AttendanceStatus,
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        workDate,
        note: null,
        createdAt: workDate,
        updatedAt: workDate,
        employee: sch.employee,
        schedule: sch,
      };
    });

    // 3. Schedule ham, attendance ham yo'q bo'lsa — barcha faol hodimlarni NO_SCHEDULE ABSENT sifatida ko'rsat
    //    (Grafik yaratilmagan, lekin hodimlar tizimda mavjud)
    const allVirtual = [...records, ...absentVirtual];

    if (allVirtual.length === 0) {
      const allEmployees = await this.prisma.employee.findMany({
        where: empFilter,
        include: { department: true, position: true },
        orderBy: { fullName: 'asc' },
      });

      if (allEmployees.length === 0) return [];

      return allEmployees.map((emp) => ({
        id: `noschedule-${emp.id}`,
        employeeId: emp.id,
        scheduleId: null,
        deviceId: null,
        rawCheckInTime: null,
        rawCheckOutTime: null,
        checkIn: null,
        checkOut: null,
        expectedCheckIn: null,
        expectedCheckOut: null,
        status: 'ABSENT' as AttendanceStatus,
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        workDate,
        note: 'Grafik yo\'q',
        createdAt: workDate,
        updatedAt: workDate,
        employee: emp,
        schedule: null,
      }));
    }

    // Merge: real records + virtual absent, sort by fullName
    return allVirtual.sort((a, b) =>
      (a.employee as any).fullName.localeCompare((b.employee as any).fullName),
    );
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
    const expectedCheckIn = schedule?.shift
      ? DateUtil.buildDateTime(workDate, schedule.shift.startTime)
      : DateUtil.buildDateTime(workDate, '08:00'); // default 08:00 (tungi 00:00 emas!)
    const expectedCheckOut = schedule
      ? this.buildExpectedCheckOut(schedule, workDate)
      : new Date(workDate.getTime() + 12 * 3600 * 1000);

    const lateMinutes = this.calcLateMinutes(eventDate, expectedCheckIn, LATE_GRACE_MINUTES);
    const newStatus: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

    const existing = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, workDate },
    });

    if (existing) {
      return this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { checkIn: eventDate, lateMinutes, status: newStatus, note },
      });
    }

    return this.prisma.attendanceRecord.create({
      data: {
        employeeId,
        scheduleId: schedule?.id,
        checkIn: eventDate,
        expectedCheckIn,
        expectedCheckOut,
        workDate,
        status: newStatus,
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

    // Allaqachon davomat yozilgan xodimlar ID larini bitta so'rovda olib qo'yamiz (N+1 oldini olish)
    const existingIds = await this.prisma.attendanceRecord.findMany({
      where: { workDate },
      select: { employeeId: true },
    });
    const attendedSet = new Set(existingIds.map((r) => r.employeeId));

    const toCreate = scheduledToday
      .filter((sch) => !attendedSet.has(sch.employeeId) && sch.shift)
      .map((sch) => ({
        employeeId: sch.employeeId,
        scheduleId: sch.id,
        expectedCheckIn: DateUtil.buildDateTime(workDate, sch.shift!.startTime),
        expectedCheckOut: this.buildExpectedCheckOut(sch as any, workDate),
        workDate,
        status: 'ABSENT' as AttendanceStatus,
      }));

    if (toCreate.length > 0) {
      await this.prisma.attendanceRecord.createMany({ data: toCreate, skipDuplicates: true });
    }

    return { marked: toCreate.length };
  }

  // ──────────────────────────────────────────
  // PRIVATE HELPERS
  // ──────────────────────────────────────────

  /**
   * Schedule yo'q bo'lsa, hospitalning shift templatelaridan mos smenani topish.
   * Kelish vaqtiga qarab: 10:00 dan oldin → kechki smena (overnight), keyin → kunduzgi
   */
  private async findFallbackShift(hospitalId: string | null, eventTz: Dayjs) {
    if (!hospitalId) return null;
    const shifts = await this.prisma.shiftTemplate.findMany({ where: { hospitalId } });
    if (!shifts.length) return null;

    const hour = eventTz.hour();
    // Before 10:00 → likely overnight shift ending, otherwise day shift
    if (hour < 10) {
      const night = shifts.find(s => s.isOvernight);
      if (night) return night;
    }
    // Default to day shift (earliest startTime)
    const day = shifts.find(s => !s.isOvernight);
    return day || shifts[0];
  }

  private async findTodaySchedule(employeeId: string, workDate: Date, eventTz: Dayjs) {
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
   * Scan vaqti tushlik boshlanishiga yaqinmi? (±LUNCH_WINDOW_MIN minutda)
   */
  private isNearLunchStart(eventTime: Date, lunchStart: string): boolean {
    const [h, m] = lunchStart.split(':').map(Number);
    const tzEvent = dayjs(eventTime).tz(TZ);
    const lunchStartMin = h * 60 + m;
    const eventMin = tzEvent.hour() * 60 + tzEvent.minute();
    return Math.abs(eventMin - lunchStartMin) <= LUNCH_WINDOW_MIN;
  }

  /**
   * Tushlikdan kech qaytish minutlari
   * lunchEnd yo'q yoki grace ichida bo'lsa → 0
   */
  private calcLunchLateMinutes(returnTime: Date, lunchEnd?: string | null, graceMin = 10): number {
    if (!lunchEnd) return 0;
    const [h, m] = lunchEnd.split(':').map(Number);
    const tzReturn = dayjs(returnTime).tz(TZ);
    const lunchEndDt = tzReturn.startOf('day').add(h * 60 + m, 'minute');
    const diffMin = tzReturn.diff(lunchEndDt, 'minute');
    if (diffMin <= graceMin) return 0;
    return diffMin - graceMin;
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
        const monthWorkMinutes = 26 * 8 * 60; // 26 ish kuni × 8 soat = 12,480 min (standart 8h shift)
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
