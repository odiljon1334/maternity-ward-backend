import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, TerminalEventType } from '@prisma/client';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';

import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { isHospitalBlocked } from '../common/utils/payment.util';
import { calcNetWorkMin } from '../common/utils/shift.util';
import { LATE_GRACE_MINUTES, WEEKLY_LATE_THRESHOLD_MIN } from '../common/constants';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/**
 * Minimal vaqt (daqiqa) — check-in dan keyin CHECK_OUT bo'la olishi uchun.
 * Bu qiymatdan kam bo'lsa — terminal dublikati sifatida ignore qilinadi.
 */
const MIN_CHECKOUT_GAP_MIN = 120;

/** Vaqt-based tushlik aniqlash oynasi (±daqiqa) */
const LUNCH_WINDOW_MIN = 45;

// ─── PUBLIC TYPES ─────────────────────────────────────────────────────────────

/** Webhook controller tomonidan to'ldirilgan hodisa */
export interface HikvisionEvent {
  employeeNo:        string;
  deviceId?:         string;
  deviceName?:       string;
  eventTime?:        string;
  /**
   * Terminal tugmasi bosilganda aniq status.
   * null = terminal status yuborмади → time-based fallback ishlatiladi.
   */
  terminalEventType: TerminalEventType | null;
  rawPayload?:       any;
}

/** processHikvisionEvent natijasi */
export interface ProcessResult {
  employee:        any;
  action:          TerminalEventType;
  attendance:      any;
  /** false bo'lsa — Telegram xabar yuborilmaydi (tushlik/coffee return uchun) */
  notifyTelegram:  boolean;
}

// ─── SERVICE ──────────────────────────────────────────────────────────────────

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────────────────────────────────────
  // PUBLIC: HIKVISION WEBHOOK — asosiy kirish nuqtasi
  // ──────────────────────────────────────────────────────────────────────────────

  async processHikvisionEvent(event: HikvisionEvent): Promise<ProcessResult | null> {
    const { employeeNo, deviceId, deviceName, eventTime, terminalEventType, rawPayload } = event;

    // 1. Xodimni topish
    const employee = await this.prisma.employee.findUnique({
      where: { employeeNo },
      include: { department: true, position: true, hospital: true },
    });

    if (!employee) {
      this.logger.warn(`Noma'lum xodim: ${employeeNo}`);
      return null;
    }

    // 2. Kasalxona blok tekshiruvi
    if (await isHospitalBlocked(this.prisma, employee.hospitalId)) {
      this.logger.warn(`Kasalxona ${employee.hospitalId} BLOCKED — ${employee.fullName} uchun davomat yozilmadi`);
      return null;
    }

    const eventDate = DateUtil.parseTerminalTime(eventTime);
    const workDate  = DateUtil.startOfDay(eventDate);
    const tzDate    = dayjs(eventDate).tz(TZ);

    // 3. Bugungi jadval
    const schedule     = await this.findTodaySchedule(employee.id, workDate, tzDate);
    const fallbackShift = !schedule
      ? await this.findFallbackShift(employee.hospitalId, tzDate)
      : null;
    const shift = schedule?.shift ?? fallbackShift ?? null;

    // 4. Bugungi davomat yozuvi
    const attendance = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId: employee.id, workDate },
    });

    // 5. Event turini aniqlash: terminal explicit → fallback time-based
    const resolvedType = terminalEventType
      ?? this.inferEventType(attendance, eventDate, shift);

    this.logger.log(
      `${employee.fullName} | type=${resolvedType} | ` +
      `explicit=${terminalEventType ?? 'none'} | time=${eventDate.toISOString()}`,
    );

    // 6. AttendanceEvent (audit log) — har doim saqlanadi
    await this.saveAttendanceEvent({
      employeeId: employee.id,
      eventType:  resolvedType,
      deviceId,
      deviceName,
      rawTime:    eventDate,
      rawPayload,
      recordId:   attendance?.id ?? null,
    });

    // 7. Harakatni bajarish
    return this.dispatch(resolvedType, {
      employee,
      eventDate,
      workDate,
      tzDate,
      schedule,
      fallbackShift,
      shift,
      attendance,
      deviceId,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: DISPATCHER — action ga qarab to'g'ri handler ga yo'naltiradi
  // ──────────────────────────────────────────────────────────────────────────────

  private async dispatch(
    type: TerminalEventType,
    ctx: EventContext,
  ): Promise<ProcessResult | null> {
    const { employee, attendance } = ctx;

    switch (type) {
      case TerminalEventType.CHECK_IN:
        return this.handleCheckIn(ctx);

      case TerminalEventType.CHECK_OUT:
        if (!attendance) {
          this.logger.warn(`${employee.fullName}: CHECK_OUT keldi lekin check-in yo'q — ignore`);
          return null;
        }
        if (attendance.checkOut) {
          this.logger.log(`${employee.fullName}: allaqachon check-out qilgan — ignore`);
          return null;
        }
        return this.handleCheckOut(ctx);

      case TerminalEventType.LUNCH_OUT:
        if (!attendance || attendance.checkOut) return null;
        return this.handleLunchOut(ctx);

      case TerminalEventType.LUNCH_IN:
        if (!attendance || !attendance.lunchOut || attendance.lunchIn) return null;
        return this.handleLunchIn(ctx);

      case TerminalEventType.COFFEE_OUT:
        if (!attendance || attendance.checkOut) return null;
        return this.handleCoffeeOut(ctx);

      case TerminalEventType.COFFEE_IN:
        if (!attendance || !attendance.coffeeOut || attendance.coffeeIn) return null;
        return this.handleCoffeeIn(ctx);

      case TerminalEventType.OVERTIME_IN:
      case TerminalEventType.OVERTIME_OUT:
        // TODO: keyingi phase da qo'shiladi
        this.logger.log(`Overtime event — hozircha ignore: ${type}`);
        return null;

      default:
        this.logger.warn(`Noma'lum terminal event turi: ${type}`);
        return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: ACTION HANDLERS
  // ──────────────────────────────────────────────────────────────────────────────

  /** Xodim keldi — yangi AttendanceRecord yaratadi */
  private async handleCheckIn(ctx: EventContext): Promise<ProcessResult | null> {
    const { employee, eventDate, workDate, schedule, fallbackShift, deviceId } = ctx;

    if (ctx.attendance) {
      // Allaqachon check-in bor — ignore (duplicate scan)
      const gap = DateUtil.diffMinutes(eventDate, ctx.attendance.checkIn!);
      this.logger.log(
        `${employee.fullName}: duplicate CHECK_IN (gap=${gap}min) — ignore`,
      );
      return null;
    }

    const expectedCheckIn = this.buildExpectedCheckIn(workDate, schedule, fallbackShift);
    const expectedCheckOut = this.buildExpectedCheckOut(workDate, schedule, fallbackShift);

    const graceMin  = schedule?.shift?.graceMinutes ?? fallbackShift?.graceMinutes ?? LATE_GRACE_MINUTES;
    const lateMinutes = this.calcLateMinutes(eventDate, expectedCheckIn, graceMin);
    const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

    const attendance = await this.prisma.attendanceRecord.create({
      data: {
        employeeId:       employee.id,
        scheduleId:       schedule?.id,
        deviceId,
        rawCheckInTime:   eventDate,
        checkIn:          eventDate,
        expectedCheckIn,
        expectedCheckOut,
        workDate,
        status,
        lateMinutes,
      },
    });

    await this.updateAttendanceEventRecord(employee.id, eventDate, attendance.id);
    await this.updateWeeklyStats(employee.id, eventDate, lateMinutes, 0, 0, true); // isCheckIn=true

    return { employee, action: TerminalEventType.CHECK_IN, attendance, notifyTelegram: true };
  }

  /** Xodim ketdi — AttendanceRecord ni yakunlaydi */
  private async handleCheckOut(ctx: EventContext): Promise<ProcessResult> {
    const { employee, eventDate, attendance, schedule, fallbackShift } = ctx;
    const rec = attendance!;

    // expectedCheckOut null bo'lsa — shift dan qayta hisoblash
    const expectedEnd: Date = rec.expectedCheckOut
      ?? this.buildExpectedCheckOut(rec.workDate, schedule, fallbackShift);

    const earlyLeaveMin   = this.calcEarlyLeaveMinutes(eventDate, expectedEnd);
    const overtimeMinutes = this.calcOvertimeMinutes(eventDate, expectedEnd);
    const newStatus       = this.recalcStatus(rec.status, rec.lateMinutes, earlyLeaveMin);

    // Sof ish vaqti: brutto − tushlik (haqiqiy yoki rejalashtirilgan)
    const shift = schedule?.shift ?? fallbackShift;
    const netWorkMin = rec.checkIn
      ? calcNetWorkMin(
          rec.checkIn,
          eventDate,
          rec.lunchOut,
          rec.lunchIn,
          shift?.lunchStart,
          shift?.lunchEnd,
        )
      : 0;

    const updated = await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: {
        rawCheckOutTime: eventDate,
        checkOut:        eventDate,
        earlyLeaveMin,
        overtimeMinutes,
        netWorkMin,
        status:          newStatus,
      },
    });

    await this.updateWeeklyStats(employee.id, eventDate, 0, earlyLeaveMin, overtimeMinutes);

    return { employee, action: TerminalEventType.CHECK_OUT, attendance: updated, notifyTelegram: true };
  }

  /** Tushlikka chiqdi */
  private async handleLunchOut(ctx: EventContext): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance } = ctx;
    const rec = attendance!;

    if (rec.lunchOut) {
      this.logger.log(`${employee.fullName}: lunchOut allaqachon yozilgan — ignore`);
      return null;
    }

    await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: { lunchOut: eventDate },
    });

    // BreakRecord yaratish (audit + kelajakda reporting uchun)
    await this.prisma.breakRecord.create({
      data: { recordId: rec.id, type: 'LUNCH', startTime: eventDate },
    });

    this.logger.log(`Tushlik OUT: ${employee.fullName}`);
    return { employee, action: TerminalEventType.LUNCH_OUT, attendance: rec, notifyTelegram: false };
  }

  /** Tushlikdan qaytdi */
  private async handleLunchIn(ctx: EventContext): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance, shift } = ctx;
    const rec = attendance!;

    const lunchLateMin = this.calcLunchLateMinutes(eventDate, shift?.lunchEnd, shift?.lunchGraceMin);
    const newLateMin   = rec.lateMinutes + lunchLateMin;
    const newStatus    = this.recalcStatus(rec.status, newLateMin, rec.earlyLeaveMin);

    await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: { lunchIn: eventDate, lunchLateMin, lateMinutes: newLateMin, status: newStatus },
    });

    // BreakRecord ni yangilash (endTime qo'shish)
    const openBreak = await this.prisma.breakRecord.findFirst({
      where: { recordId: rec.id, type: 'LUNCH', endTime: null },
      orderBy: { createdAt: 'desc' },
    });
    if (openBreak) {
      await this.prisma.breakRecord.update({
        where: { id: openBreak.id },
        data: { endTime: eventDate, lateMin: lunchLateMin },
      });
    }

    if (lunchLateMin > 0) {
      await this.updateWeeklyStats(employee.id, eventDate, lunchLateMin, 0, 0);
      this.logger.log(`Tushlik IN (${lunchLateMin}min kech): ${employee.fullName}`);
    } else {
      this.logger.log(`Tushlik IN (o'z vaqtida): ${employee.fullName}`);
    }

    return { employee, action: TerminalEventType.LUNCH_IN, attendance: rec, notifyTelegram: false };
  }

  /** Coffee/tanaffusga chiqdi */
  private async handleCoffeeOut(ctx: EventContext): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance } = ctx;
    const rec = attendance!;

    if (rec.coffeeOut) {
      this.logger.log(`${employee.fullName}: coffeeOut allaqachon yozilgan — ignore`);
      return null;
    }

    await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: { coffeeOut: eventDate },
    });

    await this.prisma.breakRecord.create({
      data: { recordId: rec.id, type: 'COFFEE', startTime: eventDate },
    });

    this.logger.log(`Coffee OUT: ${employee.fullName}`);
    return { employee, action: TerminalEventType.COFFEE_OUT, attendance: rec, notifyTelegram: false };
  }

  /** Coffee/tanaffusdan qaytdi */
  private async handleCoffeeIn(ctx: EventContext): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance } = ctx;
    const rec = attendance!;

    await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: { coffeeIn: eventDate },
    });

    const openBreak = await this.prisma.breakRecord.findFirst({
      where: { recordId: rec.id, type: 'COFFEE', endTime: null },
      orderBy: { createdAt: 'desc' },
    });
    if (openBreak) {
      await this.prisma.breakRecord.update({
        where: { id: openBreak.id },
        data: { endTime: eventDate },
      });
    }

    this.logger.log(`Coffee IN: ${employee.fullName}`);
    return { employee, action: TerminalEventType.COFFEE_IN, attendance: rec, notifyTelegram: false };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: TIME-BASED FALLBACK
  // Terminal status yuborмаса — vaqtga qarab event turini taxmin qiladi
  // ──────────────────────────────────────────────────────────────────────────────

  private inferEventType(
    attendance: any | null,
    eventDate: Date,
    shift: any | null,
  ): TerminalEventType {
    // Davomat yo'q → birinchi scan = CHECK_IN
    if (!attendance) return TerminalEventType.CHECK_IN;

    // Allaqachon checkout qilgan → ignore (UNKNOWN sifatida qaytaradi, dispatcher null qaytaradi)
    if (attendance.checkOut) return TerminalEventType.UNKNOWN;

    const gapFromCheckIn = DateUtil.diffMinutes(eventDate, attendance.checkIn!);

    // Agar checkout gap yetarli bo'lmasa → tushlik/coffee bo'lishi mumkin
    const canBeCheckout = gapFromCheckIn >= MIN_CHECKOUT_GAP_MIN;

    // Tushlik chiqish: lunchOut yo'q, shift da lunchStart bor, vaqt oynada, gap emas
    if (!attendance.lunchOut && shift?.lunchStart && !canBeCheckout) {
      if (this.isNearLunchStart(eventDate, shift.lunchStart)) {
        return TerminalEventType.LUNCH_OUT;
      }
    }

    // Tushlikdan qaytish: lunchOut bor, lunchIn yo'q
    if (attendance.lunchOut && !attendance.lunchIn) {
      return TerminalEventType.LUNCH_IN;
    }

    // Gap yetarli → CHECK_OUT
    if (canBeCheckout) return TerminalEventType.CHECK_OUT;

    // Qolgan holat → duplicate scan, ignore
    return TerminalEventType.UNKNOWN;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: AUDIT LOG
  // ──────────────────────────────────────────────────────────────────────────────

  private async saveAttendanceEvent(params: {
    employeeId: string;
    eventType:  TerminalEventType;
    deviceId?:  string;
    deviceName?: string;
    rawTime:    Date;
    rawPayload?: any;
    recordId:   string | null;
  }): Promise<void> {
    try {
      await this.prisma.attendanceEvent.create({
        data: {
          employeeId: params.employeeId,
          eventType:  params.eventType,
          deviceId:   params.deviceId,
          deviceName: params.deviceName,
          rawTime:    params.rawTime,
          rawPayload: params.rawPayload ?? null,
          recordId:   params.recordId,
        },
      });
    } catch (err) {
      // Audit log xatosi asosiy jarayonni to'xtatmasin
      this.logger.error(`AttendanceEvent saqlanmadi: ${err.message}`);
    }
  }

  /** Yangi AttendanceRecord yaratilganda — shu kun uchun oldingi eventlarni ulaydi */
  private async updateAttendanceEventRecord(
    employeeId: string,
    date: Date,
    recordId: string,
  ): Promise<void> {
    const dayStart = DateUtil.startOfDay(date);
    const dayEnd   = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    try {
      await this.prisma.attendanceEvent.updateMany({
        where: {
          employeeId,
          rawTime:  { gte: dayStart, lt: dayEnd },
          recordId: null,
        },
        data: { recordId },
      });
    } catch { /* ignore */ }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PUBLIC: GET METHODS
  // ──────────────────────────────────────────────────────────────────────────────

  async getMyAttendance(userId: string, month: number, year: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!user?.employee) throw new NotFoundException('Bu foydalanuvchi uchun xodim profili topilmadi');
    return this.getEmployeeAttendance(user.employee.id, month, year);
  }

  async getEmployeeAttendance(employeeId: string, month: number, year: number) {
    const start = DateUtil.startOfMonth(year, month);
    const end   = DateUtil.endOfMonth(year, month);

    const records = await this.prisma.attendanceRecord.findMany({
      where:   { employeeId, workDate: { gte: start, lte: end } },
      include: { schedule: { include: { shift: true } }, breaks: true },
      orderBy: { workDate: 'asc' },
    });

    const stats = {
      totalDays:      records.length,
      present:        records.filter(r => r.status === 'PRESENT').length,
      late:           records.filter(r => ['LATE', 'LATE_EARLY'].includes(r.status)).length,
      absent:         records.filter(r => r.status === 'ABSENT').length,
      earlyLeave:     records.filter(r => ['EARLY_LEAVE', 'LATE_EARLY'].includes(r.status)).length,
      totalLateMin:   records.reduce((s, r) => s + r.lateMinutes, 0),
      totalOvertimeMin: records.reduce((s, r) => s + r.overtimeMinutes, 0),
    };

    return { records, stats };
  }

  async getDailyAttendance(date: string, departmentId?: string, hospitalId?: string) {
    const workDate = DateUtil.startOfDay(date);

    const empFilter: any = { firedAt: null };
    if (hospitalId)   empFilter.hospitalId   = hospitalId;
    if (departmentId) empFilter.departmentId = departmentId;

    const records = await this.prisma.attendanceRecord.findMany({
      where:   { workDate, employee: empFilter },
      include: {
        employee: { include: { department: true, position: true } },
        schedule: { include: { shift: true } },
        breaks:   true,
      },
      orderBy: { employee: { fullName: 'asc' } },
    });

    const attendedIds = new Set(records.map(r => r.employeeId));

    const scheduledMissing = await this.prisma.schedule.findMany({
      where: {
        date:       workDate,
        status:     'WORKING',
        employeeId: { notIn: [...attendedIds] },
        employee:   empFilter,
      },
      include: {
        shift:    true,
        employee: { include: { department: true, position: true } },
      },
    });

    const absentVirtual = scheduledMissing.map(sch => ({
      id:               `absent-${sch.employeeId}`,
      employeeId:       sch.employeeId,
      scheduleId:       sch.id,
      deviceId:         null,
      rawCheckInTime:   null,
      rawCheckOutTime:  null,
      checkIn:          null,
      checkOut:         null,
      lunchOut:         null,
      lunchIn:          null,
      lunchLateMin:     0,
      coffeeOut:        null,
      coffeeIn:         null,
      coffeeLateMin:    0,
      expectedCheckIn:  sch.shift
        ? DateUtil.buildDateTime(workDate, sch.shift.startTime)
        : new Date(workDate.getTime() + 8 * 3600 * 1000),
      expectedCheckOut: sch.shift
        ? (sch.shift.isOvernight
            ? DateUtil.buildDateTime(dayjs(workDate).add(1, 'day').toDate(), sch.shift.endTime)
            : DateUtil.buildDateTime(workDate, sch.shift.endTime))
        : new Date(workDate.getTime() + 20 * 3600 * 1000),
      status:           'ABSENT' as AttendanceStatus,
      lateMinutes:      0,
      earlyLeaveMin:    0,
      overtimeMinutes:  0,
      workDate,
      note:             null,
      breaks:           [],
      createdAt:        workDate,
      updatedAt:        workDate,
      employee:         sch.employee,
      schedule:         sch,
    }));

    const allVirtual = [...records, ...absentVirtual];

    if (allVirtual.length === 0) {
      const allEmployees = await this.prisma.employee.findMany({
        where:   empFilter,
        include: { department: true, position: true },
        orderBy: { fullName: 'asc' },
      });
      if (allEmployees.length === 0) return [];

      return allEmployees.map(emp => ({
        id:              `noschedule-${emp.id}`,
        employeeId:      emp.id,
        scheduleId:      null,
        deviceId:        null,
        checkIn:         null,
        checkOut:        null,
        lunchOut:        null,
        lunchIn:         null,
        lunchLateMin:    0,
        coffeeOut:       null,
        coffeeIn:        null,
        coffeeLateMin:   0,
        expectedCheckIn:  null,
        expectedCheckOut: null,
        status:          'ABSENT' as AttendanceStatus,
        lateMinutes:     0,
        earlyLeaveMin:   0,
        overtimeMinutes: 0,
        workDate,
        note:            "Grafik yo'q",
        breaks:          [],
        createdAt:       workDate,
        updatedAt:       workDate,
        employee:        emp,
        schedule:        null,
      }));
    }

    return allVirtual.sort((a, b) =>
      (a.employee as any).fullName.localeCompare((b.employee as any).fullName),
    );
  }

  async getWeeklyStats(employeeId: string, weekStart: string) {
    const start = DateUtil.startOfWeek(weekStart);
    return this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: start } },
    });
  }

  async manualCheckIn(employeeId: string, checkInTime: string, note?: string) {
    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    const eventDate  = new Date(checkInTime);
    const workDate   = DateUtil.startOfDay(eventDate);
    const schedule   = await this.findTodaySchedule(employeeId, workDate, dayjs(eventDate).tz(TZ));

    const expectedCheckIn = schedule?.shift
      ? DateUtil.buildDateTime(workDate, schedule.shift.startTime)
      : DateUtil.buildDateTime(workDate, '08:00');
    const expectedCheckOut = schedule
      ? this.buildExpectedCheckOut(workDate, schedule, null)
      : new Date(workDate.getTime() + 12 * 3600 * 1000);

    const lateMinutes = this.calcLateMinutes(eventDate, expectedCheckIn, LATE_GRACE_MINUTES);
    const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

    const existing = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, workDate },
    });

    if (existing) {
      return this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data:  { checkIn: eventDate, lateMinutes, status, note },
      });
    }

    return this.prisma.attendanceRecord.create({
      data: {
        employeeId,
        scheduleId:       schedule?.id,
        checkIn:          eventDate,
        expectedCheckIn,
        expectedCheckOut,
        workDate,
        status,
        lateMinutes,
        note,
      },
    });
  }

  async markAbsentForToday() {
    const workDate = DateUtil.startOfDay(new Date());

    const scheduledToday = await this.prisma.schedule.findMany({
      where:  { date: workDate, status: 'WORKING' },
      select: { id: true, employeeId: true, shiftId: true, shift: true },
    });

    const existingIds = await this.prisma.attendanceRecord.findMany({
      where:  { workDate },
      select: { employeeId: true },
    });
    const attendedSet = new Set(existingIds.map(r => r.employeeId));

    const toCreate = scheduledToday
      .filter(sch => !attendedSet.has(sch.employeeId) && sch.shift)
      .map(sch => ({
        employeeId:       sch.employeeId,
        scheduleId:       sch.id,
        expectedCheckIn:  DateUtil.buildDateTime(workDate, sch.shift!.startTime),
        expectedCheckOut: this.buildExpectedCheckOut(workDate, sch as any, null),
        workDate,
        status:           'ABSENT' as AttendanceStatus,
      }));

    if (toCreate.length > 0) {
      await this.prisma.attendanceRecord.createMany({ data: toCreate, skipDuplicates: true });
    }

    return { marked: toCreate.length };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: SCHEDULE HELPERS
  // ──────────────────────────────────────────────────────────────────────────────

  private async findTodaySchedule(employeeId: string, workDate: Date, eventTz: Dayjs) {
    let schedule = await this.prisma.schedule.findUnique({
      where:   { employeeId_date: { employeeId, date: workDate } },
      include: { shift: true },
    });

    // Tungi smena: soat 10 dan oldin bo'lsa — kechagi jadvalga qaraydi
    if (!schedule && eventTz.hour() < 10) {
      const yesterday = DateUtil.startOfDay(dayjs(workDate).subtract(1, 'day').toDate());
      const ySch = await this.prisma.schedule.findUnique({
        where:   { employeeId_date: { employeeId, date: yesterday } },
        include: { shift: true },
      });
      if (ySch?.shift?.isOvernight) schedule = ySch;
    }

    return schedule?.status === 'WORKING' ? schedule : null;
  }

  private async findFallbackShift(hospitalId: string | null, eventTz: Dayjs) {
    if (!hospitalId) return null;
    const shifts = await this.prisma.shiftTemplate.findMany({ where: { hospitalId } });
    if (!shifts.length) return null;

    const hour = eventTz.hour();
    if (hour < 10) {
      const night = shifts.find(s => s.isOvernight);
      if (night) return night;
    }
    return shifts.find(s => !s.isOvernight) ?? shifts[0];
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: CALCULATION HELPERS
  // ──────────────────────────────────────────────────────────────────────────────

  private buildExpectedCheckIn(
    workDate: Date,
    schedule: any | null,
    fallbackShift: any | null,
  ): Date {
    const startTime = schedule?.shift?.startTime ?? fallbackShift?.startTime ?? '08:00';
    return DateUtil.buildDateTime(workDate, startTime);
  }

  private buildExpectedCheckOut(
    workDate: Date,
    schedule: any | null,
    fallbackShift: any | null,
  ): Date {
    const shift = schedule?.shift ?? fallbackShift;
    if (!shift) return new Date(workDate.getTime() + 12 * 3600 * 1000);
    if (shift.isOvernight) {
      return DateUtil.buildDateTime(dayjs(workDate).add(1, 'day').toDate(), shift.endTime);
    }
    return DateUtil.buildDateTime(workDate, shift.endTime);
  }

  private calcLateMinutes(checkIn: Date, expected: Date, graceMin: number): number {
    const diff = DateUtil.diffMinutes(checkIn, expected);
    return diff <= graceMin ? 0 : diff - graceMin;
  }

  private calcEarlyLeaveMinutes(checkOut: Date, expectedEnd: Date | null): number {
    if (!expectedEnd) return 0;
    // Sanalar bir xil kunda bo'lishi kerak — boshqa kunda bo'lsa ignore
    const sameDay = DateUtil.startOfDay(checkOut).getTime() === DateUtil.startOfDay(expectedEnd).getTime();
    if (!sameDay) return 0;
    return Math.max(0, DateUtil.diffMinutes(expectedEnd, checkOut));
  }

  private calcOvertimeMinutes(checkOut: Date, expectedEnd: Date | null): number {
    if (!expectedEnd) return 0;
    const sameDay = DateUtil.startOfDay(checkOut).getTime() === DateUtil.startOfDay(expectedEnd).getTime();
    if (!sameDay) return 0;
    return Math.max(0, DateUtil.diffMinutes(checkOut, expectedEnd));
  }

  private calcLunchLateMinutes(
    returnTime: Date,
    lunchEnd?: string | null,
    graceMin = 10,
  ): number {
    if (!lunchEnd) return 0;
    const [h, m]     = lunchEnd.split(':').map(Number);
    const tzReturn   = dayjs(returnTime).tz(TZ);
    const lunchEndDt = tzReturn.startOf('day').add(h * 60 + m, 'minute');
    const diff       = tzReturn.diff(lunchEndDt, 'minute');
    return diff <= graceMin ? 0 : diff - graceMin;
  }

  private isNearLunchStart(eventTime: Date, lunchStart: string): boolean {
    const [h, m]   = lunchStart.split(':').map(Number);
    const tzEvent  = dayjs(eventTime).tz(TZ);
    const lunchMin = h * 60 + m;
    const eventMin = tzEvent.hour() * 60 + tzEvent.minute();
    return Math.abs(eventMin - lunchMin) <= LUNCH_WINDOW_MIN;
  }

  /**
   * Mavjud status + yangi late/earlyLeave ga qarab qayta hisoblaydi.
   */
  private recalcStatus(
    current: AttendanceStatus,
    lateMin: number,
    earlyMin: number,
  ): AttendanceStatus {
    if (lateMin > 0 && earlyMin > 0) return 'LATE_EARLY';
    if (earlyMin > 0)                return 'EARLY_LEAVE';
    if (lateMin > 0)                 return 'LATE';
    return current === 'ABSENT' ? 'PRESENT' : current;
  }

  private async updateWeeklyStats(
    employeeId: string,
    date: Date,
    addLateMin: number,
    addEarlyMin: number,
    addOvertime: number,
    isCheckIn = false,   // faqat check-in da daysWorked oshadi
  ) {
    const weekStart = DateUtil.startOfWeek(date);
    const weekEnd   = DateUtil.endOfWeek(date);

    const existing = await this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart } },
    });

    const prevLate       = existing?.totalLateMin ?? 0;
    const newLate        = prevLate + addLateMin;
    const penaltyLateMin = Math.max(0, newLate - WEEKLY_LATE_THRESHOLD_MIN);

    let deductionAmount = 0;
    if (penaltyLateMin > 0) {
      const emp = await this.prisma.employee.findUnique({
        where:  { id: employeeId },
        select: { baseSalary: true },
      });
      if (emp) {
        const monthWorkMinutes = 26 * 8 * 60;
        const minuteRate       = Number(emp.baseSalary) / monthWorkMinutes;
        const addedPenalty     = penaltyLateMin - (existing?.penaltyLateMin ?? 0);
        deductionAmount = (existing ? Number(existing.deductionAmount) : 0) + addedPenalty * minuteRate;
      }
    }

    await this.prisma.weeklyAttendanceStat.upsert({
      where:  { employeeId_weekStart: { employeeId, weekStart } },
      update: {
        totalLateMin:  { increment: addLateMin },
        totalEarlyMin: { increment: addEarlyMin },
        totalOvertime: { increment: addOvertime },
        ...(isCheckIn && { daysWorked: { increment: 1 } }),
        penaltyLateMin,
        deductionAmount,
      },
      create: {
        employeeId,
        weekStart,
        weekEnd,
        totalLateMin:  addLateMin,
        totalEarlyMin: addEarlyMin,
        totalOvertime: addOvertime,
        daysWorked:    isCheckIn ? 1 : 0,   // har doim check-in da 1 dan boshlaydi
        penaltyLateMin,
        deductionAmount,
      },
    });
  }
}

// ─── INTERNAL TYPE ───────────────────────────────────────────────────────────

/** dispatch() ga uzatiladigan kontekst */
interface EventContext {
  employee:      any;
  eventDate:     Date;
  workDate:      Date;
  tzDate:        Dayjs;
  schedule:      any | null;
  fallbackShift: any | null;
  shift:         any | null;
  attendance:    any | null;
  deviceId?:     string;
}
