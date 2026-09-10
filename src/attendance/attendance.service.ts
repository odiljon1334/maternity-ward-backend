import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceStatus,
  ScheduleStatus,
  TerminalEventType,
} from '@prisma/client';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';
import * as path from 'path';

import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { DateUtil } from '../common/utils/date.util';
import { isHospitalBlocked } from '../common/utils/payment.util';
import { calcNetWorkMin } from '../common/utils/shift.util';
import { haversineMeters, formatDistance } from '../common/utils/geo.util';
import { processAndSavePhoto } from '../common/utils/image.util';
import {
  LATE_GRACE_MINUTES,
  WEEKLY_LATE_THRESHOLD_MIN,
} from '../common/constants';
import { SelfCheckInDto } from './dto/self-check-in.dto';
import { LocationGateway } from '../location/location.gateway';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/**
 * Minimal vaqt (daqiqa) — check-in dan keyin CHECK_OUT bo'la olishi uchun.
 * Bu qiymatdan kam bo'lsa — terminal dublikati sifatida ignore qilinadi.
 */
const MIN_CHECKOUT_GAP_MIN = 120;

/**
 * Xodimning ish joyi koordinatasini saqlash uchun ruxsat etilgan eng past
 * aniqlik (metr). Bundan yomon o'lchov Wi-Fi/antenna orqali topilgan taxminiy
 * nuqta bo'ladi va ish joyini noto'g'ri belgilab qo'yadi.
 */
const EMPLOYEE_GPS_MAX_ACCURACY_M = 75;

/**
 * Grafigi yo'q xodim uchun smena TAXMIN qilinadi. Taxmin noto'g'ri chiqsa
 * absurd kechikish yozilib qolmasligi kerak (masalan 660 daqiqa) — bunday
 * holatda kechikish qayd etilmaydi va direktorga noto'g'ri xabar ketmaydi.
 * Haqiqiy grafik bo'lsa bu chegara qo'llanilmaydi.
 */
const MAX_GUESSED_LATE_MIN = 240;

/** Vaqt-based tushlik aniqlash oynasi (±daqiqa) */
const LUNCH_WINDOW_MIN = 45;

// ─── PUBLIC TYPES ─────────────────────────────────────────────────────────────

/** Webhook controller tomonidan to'ldirilgan hodisa */
export interface HikvisionEvent {
  employeeNo: string;
  deviceId?: string;
  deviceName?: string;
  eventTime?: string;
  /**
   * Terminal tugmasi bosilganda aniq status.
   * null = terminal status yuborмади → time-based fallback ishlatiladi.
   */
  terminalEventType: TerminalEventType | null;
  rawPayload?: any;
}

/** processHikvisionEvent natijasi */
export interface ProcessResult {
  employee: any;
  action: TerminalEventType;
  attendance: any;
  /** false bo'lsa — Telegram xabar yuborilmaydi (tushlik/coffee return uchun) */
  notifyTelegram: boolean;
}

// ─── SERVICE ──────────────────────────────────────────────────────────────────

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly locationGateway: LocationGateway,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────────
  // PUBLIC: HIKVISION WEBHOOK — asosiy kirish nuqtasi
  // ──────────────────────────────────────────────────────────────────────────────

  async processHikvisionEvent(
    event: HikvisionEvent,
  ): Promise<ProcessResult | null> {
    const {
      employeeNo,
      deviceId,
      deviceName,
      eventTime,
      terminalEventType,
      rawPayload,
    } = event;

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
      this.logger.warn(
        `Kasalxona ${employee.hospitalId} BLOCKED — ${employee.fullName} uchun davomat yozilmadi`,
      );
      return null;
    }

    const eventDate = DateUtil.parseTerminalTime(eventTime);
    const workDate = DateUtil.startOfDay(eventDate);
    const tzDate = dayjs(eventDate).tz(TZ);

    // 3. Bugungi jadval
    const schedule = await this.findTodaySchedule(
      employee.id,
      workDate,
      tzDate,
    );
    const fallbackShift = !schedule
      ? await this.findFallbackShift(employee.hospitalId, tzDate)
      : null;
    const shift = schedule?.shift ?? fallbackShift ?? null;

    // 4. Bugungi davomat yozuvi
    const attendance = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId: employee.id, workDate },
    });

    // 5. Event turini aniqlash: terminal explicit → fallback time-based
    const resolvedType =
      terminalEventType ?? this.inferEventType(attendance, eventDate, shift);

    // Diagnostika: terminal YUBORGAN xom vaqt va biz TUSHUNGAN vaqt yonma-yon.
    // Ikkalasi mos kelmasa (masalan 5 soat farq) — terminal soati yoki
    // timezone sozlamasi noto'g'ri, va xodim kech kelgan bo'lib ko'rinadi.
    this.logger.log(
      `${employee.fullName} | type=${resolvedType} | ` +
        `explicit=${terminalEventType ?? 'none'} | ` +
        `raw="${eventTime ?? 'yo\'q'}" | ` +
        `local=${tzDate.format('YYYY-MM-DD HH:mm:ss')} (${TZ})`,
    );

    // 6. AttendanceEvent (audit log) — har doim saqlanadi
    await this.saveAttendanceEvent({
      employeeId: employee.id,
      eventType: resolvedType,
      deviceId,
      deviceName,
      rawTime: eventDate,
      rawPayload,
      recordId: attendance?.id ?? null,
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

  /**
   * Dashboarddagi "Real-time keldi/ketdi" kartochkasiga signal yuboradi.
   * Xatolik bo'lsa davomat yozuvi buzilmasligi uchun yutiladi.
   */
  private emitAttendanceEvent(
    employee: any,
    action: 'CHECK_IN' | 'CHECK_OUT',
    attendance: any,
  ) {
    try {
      this.locationGateway.broadcastAttendance(employee.hospitalId ?? null, {
        id: `${attendance.id}-${action}`,
        action,
        at: (action === 'CHECK_IN'
          ? attendance.checkIn
          : attendance.checkOut
        )?.toISOString?.(),
        employee: {
          id: employee.id,
          fullName: employee.fullName,
          photoUrl: employee.photoUrl ?? null,
          department: employee.department?.name ?? null,
          position: employee.position?.name ?? null,
        },
        lateMinutes: attendance.lateMinutes ?? 0,
        earlyLeaveMin: attendance.earlyLeaveMin ?? 0,
        status: attendance.status,
      });
    } catch (e) {
      this.logger.warn(
        `attendance:event yuborilmadi: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
          this.logger.warn(
            `${employee.fullName}: CHECK_OUT keldi lekin check-in yo'q — ignore`,
          );
          return null;
        }
        if (attendance.checkOut) {
          this.logger.log(
            `${employee.fullName}: allaqachon check-out qilgan — ignore`,
          );
          return null;
        }
        return this.handleCheckOut(ctx);

      case TerminalEventType.LUNCH_OUT:
        if (!attendance || attendance.checkOut) return null;
        return this.handleLunchOut(ctx);

      case TerminalEventType.LUNCH_IN:
        if (!attendance || !attendance.lunchOut || attendance.lunchIn)
          return null;
        return this.handleLunchIn(ctx);

      case TerminalEventType.COFFEE_OUT:
        if (!attendance || attendance.checkOut) return null;
        return this.handleCoffeeOut(ctx);

      case TerminalEventType.COFFEE_IN:
        if (!attendance || !attendance.coffeeOut || attendance.coffeeIn)
          return null;
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
  private async handleCheckIn(
    ctx: EventContext,
  ): Promise<ProcessResult | null> {
    const { employee, eventDate, workDate, schedule, fallbackShift, deviceId } =
      ctx;

    if (ctx.attendance) {
      // ⚠️ Yozuv bor, lekin checkIn NULL bo'lishi MUMKIN:
      //    markAbsentForToday croni (21:00) kelmagan xodimlarga checkIn'siz
      //    ABSENT yozuvi yaratadi. Xodim keyinroq kelsa, ilgari bu yerda
      //    `ctx.attendance.checkIn!` null bo'lib TypeError bilan yiqilardi
      //    va kelgani umuman qayd etilmasdi.
      if (!ctx.attendance.checkIn) {
        return this.applyCheckInToExistingRecord(ctx);
      }

      // Allaqachon check-in bor — ignore (duplicate scan)
      const gap = DateUtil.diffMinutes(eventDate, ctx.attendance.checkIn);
      this.logger.log(
        `${employee.fullName}: duplicate CHECK_IN (gap=${gap}min) — ignore`,
      );
      return null;
    }

    const expectedCheckIn = this.buildExpectedCheckIn(
      workDate,
      schedule,
      fallbackShift,
    );
    const expectedCheckOut = this.buildExpectedCheckOut(
      workDate,
      schedule,
      fallbackShift,
    );

    const graceMin =
      schedule?.shift?.graceMinutes ??
      fallbackShift?.graceMinutes ??
      LATE_GRACE_MINUTES;
    const lateMinutes = this.resolveLateMinutes(
      eventDate,
      expectedCheckIn,
      graceMin,
      !schedule, // grafik yo'q → smena taxmin qilingan
      employee.fullName,
    );
    const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

    const attendance = await this.prisma.attendanceRecord.create({
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

    await this.updateAttendanceEventRecord(
      employee.id,
      eventDate,
      attendance.id,
    );
    await this.updateWeeklyStats(
      employee.id,
      eventDate,
      lateMinutes,
      0,
      0,
      true,
    ); // isCheckIn=true

    this.emitAttendanceEvent(employee, 'CHECK_IN', attendance);

    return {
      employee,
      action: TerminalEventType.CHECK_IN,
      attendance,
      notifyTelegram: true,
    };
  }

  /**
   * Kelish vaqti yo'q MAVJUD yozuvni (odatda cron yaratgan ABSENT) yangilaydi.
   *
   * Xodim kech bo'lsa ham kelgan — buni yo'qotmaymiz: yozuvga haqiqiy
   * kelish vaqti yoziladi va status qayta hisoblanadi.
   */
  private async applyCheckInToExistingRecord(
    ctx: EventContext,
  ): Promise<ProcessResult> {
    const { employee, eventDate, schedule, fallbackShift, deviceId } = ctx;
    const rec = ctx.attendance;

    // Kutilgan vaqt yozuvda bor (cron uni grafikdan yozgan), bo'lmasa qayta quramiz
    const expectedCheckIn =
      rec.expectedCheckIn ??
      this.buildExpectedCheckIn(ctx.workDate, schedule, fallbackShift);

    const graceMin =
      schedule?.shift?.graceMinutes ??
      fallbackShift?.graceMinutes ??
      LATE_GRACE_MINUTES;

    const lateMinutes = this.resolveLateMinutes(
      eventDate,
      expectedCheckIn,
      graceMin,
      !schedule,
      employee.fullName,
    );

    const updated = await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: {
        checkIn: eventDate,
        rawCheckInTime: eventDate,
        ...(deviceId && { deviceId }),
        expectedCheckIn,
        lateMinutes,
        status: lateMinutes > 0 ? 'LATE' : 'PRESENT',
      },
    });

    this.logger.log(
      `${employee.fullName}: kech kelib qayd etildi — ` +
        `oldingi status=${rec.status}, kechikish=${lateMinutes} daq`,
    );

    await this.updateAttendanceEventRecord(employee.id, eventDate, updated.id);
    await this.updateWeeklyStats(employee.id, eventDate, lateMinutes, 0, 0, true);

    this.emitAttendanceEvent(employee, 'CHECK_IN', updated);

    return {
      employee,
      action: TerminalEventType.CHECK_IN,
      attendance: updated,
      notifyTelegram: true,
    };
  }

  /** Xodim ketdi — AttendanceRecord ni yakunlaydi */
  private async handleCheckOut(ctx: EventContext): Promise<ProcessResult> {
    const { employee, eventDate, attendance, schedule, fallbackShift } = ctx;
    const rec = attendance!;

    // expectedCheckOut null bo'lsa — shift dan qayta hisoblash
    const expectedEnd: Date =
      rec.expectedCheckOut ??
      this.buildExpectedCheckOut(rec.workDate, schedule, fallbackShift);

    const earlyLeaveMin = this.calcEarlyLeaveMinutes(eventDate, expectedEnd);
    const overtimeMinutes = this.calcOvertimeMinutes(eventDate, expectedEnd);
    const newStatus = this.recalcStatus(
      rec.status,
      rec.lateMinutes,
      earlyLeaveMin,
    );

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
        checkOut: eventDate,
        earlyLeaveMin,
        overtimeMinutes,
        netWorkMin,
        status: newStatus,
      },
    });

    // Xodimda ilova akkaunti (userId) bo'lsa — live xaritadan darhol olib tashlash
    if (employee.userId) {
      this.locationGateway.broadcastLocationRemoved(
        employee.hospitalId,
        employee.userId,
      );
    }

    await this.updateWeeklyStats(
      employee.id,
      eventDate,
      0,
      earlyLeaveMin,
      overtimeMinutes,
    );

    this.emitAttendanceEvent(employee, 'CHECK_OUT', updated);

    return {
      employee,
      action: TerminalEventType.CHECK_OUT,
      attendance: updated,
      notifyTelegram: true,
    };
  }

  /** Tushlikka chiqdi */
  private async handleLunchOut(
    ctx: EventContext,
  ): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance } = ctx;
    const rec = attendance!;

    if (rec.lunchOut) {
      this.logger.log(
        `${employee.fullName}: lunchOut allaqachon yozilgan — ignore`,
      );
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
    return {
      employee,
      action: TerminalEventType.LUNCH_OUT,
      attendance: rec,
      notifyTelegram: false,
    };
  }

  /** Tushlikdan qaytdi */
  private async handleLunchIn(
    ctx: EventContext,
  ): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance, shift } = ctx;
    const rec = attendance!;

    const lunchLateMin = this.calcLunchLateMinutes(
      eventDate,
      shift?.lunchEnd,
      shift?.lunchGraceMin,
    );
    const newLateMin = rec.lateMinutes + lunchLateMin;
    const newStatus = this.recalcStatus(
      rec.status,
      newLateMin,
      rec.earlyLeaveMin,
    );

    await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: {
        lunchIn: eventDate,
        lunchLateMin,
        lateMinutes: newLateMin,
        status: newStatus,
      },
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
      this.logger.log(
        `Tushlik IN (${lunchLateMin}min kech): ${employee.fullName}`,
      );
    } else {
      this.logger.log(`Tushlik IN (o'z vaqtida): ${employee.fullName}`);
    }

    return {
      employee,
      action: TerminalEventType.LUNCH_IN,
      attendance: rec,
      notifyTelegram: false,
    };
  }

  /** Coffee/tanaffusga chiqdi */
  private async handleCoffeeOut(
    ctx: EventContext,
  ): Promise<ProcessResult | null> {
    const { employee, eventDate, attendance } = ctx;
    const rec = attendance!;

    if (rec.coffeeOut) {
      this.logger.log(
        `${employee.fullName}: coffeeOut allaqachon yozilgan — ignore`,
      );
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
    return {
      employee,
      action: TerminalEventType.COFFEE_OUT,
      attendance: rec,
      notifyTelegram: false,
    };
  }

  /** Coffee/tanaffusdan qaytdi */
  private async handleCoffeeIn(
    ctx: EventContext,
  ): Promise<ProcessResult | null> {
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
    return {
      employee,
      action: TerminalEventType.COFFEE_IN,
      attendance: rec,
      notifyTelegram: false,
    };
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
    eventType: TerminalEventType;
    deviceId?: string;
    deviceName?: string;
    rawTime: Date;
    rawPayload?: any;
    recordId: string | null;
  }): Promise<void> {
    try {
      await this.prisma.attendanceEvent.create({
        data: {
          employeeId: params.employeeId,
          eventType: params.eventType,
          deviceId: params.deviceId,
          deviceName: params.deviceName,
          rawTime: params.rawTime,
          rawPayload: params.rawPayload ?? null,
          recordId: params.recordId,
        },
      });
    } catch (err) {
      // Audit log xatosi asosiy jarayonni to'xtatmasin
      this.logger.error(
        `AttendanceEvent saqlanmadi: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Yangi AttendanceRecord yaratilganda — shu kun uchun oldingi eventlarni ulaydi */
  private async updateAttendanceEventRecord(
    employeeId: string,
    date: Date,
    recordId: string,
  ): Promise<void> {
    const dayStart = DateUtil.startOfDay(date);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    try {
      await this.prisma.attendanceEvent.updateMany({
        where: {
          employeeId,
          rawTime: { gte: dayStart, lt: dayEnd },
          recordId: null,
        },
        data: { recordId },
      });
    } catch {
      /* ignore */
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PUBLIC: GET METHODS
  // ──────────────────────────────────────────────────────────────────────────────

  async getMyAttendance(userId: string, month: number, year: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!user?.employee)
      throw new NotFoundException(
        'Bu foydalanuvchi uchun xodim profili topilmadi',
      );
    return this.getEmployeeAttendance(user.employee.id, month, year);
  }

  /**
   * Xodimning oylik davomat tarixi.
   *
   * `includePlanned: true` bo'lsa — davomat yozuvi bo'lmagan, lekin GRAFIGI
   * bor kunlar ham qaytariladi. Busiz "Kelishi kerak / Ketishi kerak"
   * ustunlari bo'sh qolardi: AttendanceRecord faqat terminal xodimni
   * tanigandagina yaratiladi, grafik esa undan oldin mavjud bo'ladi.
   */
  async getEmployeeAttendance(
    employeeId: string,
    month: number,
    year: number,
    opts: { includePlanned?: boolean } = {},
  ) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, workDate: { gte: start, lte: end } },
      include: { schedule: { include: { shift: true } }, breaks: true },
      orderBy: { workDate: 'asc' },
    });

    let rows: any[] = records;

    if (opts.includePlanned) {
      const schedules = await this.prisma.schedule.findMany({
        where: { employeeId, date: { gte: start, lte: end } },
        include: { shift: true },
        orderBy: { date: 'asc' },
      });

      const recordDays = new Set(
        records.map((r) => r.workDate.getTime()),
      );
      const todayStart = DateUtil.startOfDay(new Date()).getTime();

      const planned = schedules
        .filter((sch) => !recordDays.has(sch.date.getTime()))
        .map((sch) => {
          const isWorking = sch.status === 'WORKING';
          // Kelmagan deb belgilash faqat o'tgan kunlar uchun.
          // Bugungi va kelgusi kunlar — hali "reja".
          const isPast = sch.date.getTime() < todayStart;
          const status = !isWorking
            ? this.scheduleStatusToAttendance(sch.status)
            : isPast
              ? 'ABSENT'
              : 'PLANNED';

          return {
            id: `planned-${sch.id}`,
            employeeId,
            scheduleId: sch.id,
            deviceId: null,
            rawCheckInTime: null,
            rawCheckOutTime: null,
            checkIn: null,
            checkOut: null,
            lunchOut: null,
            lunchIn: null,
            lunchLateMin: 0,
            coffeeOut: null,
            coffeeIn: null,
            coffeeLateMin: 0,
            expectedCheckIn:
              isWorking && sch.shift
                ? DateUtil.buildDateTime(sch.date, sch.shift.startTime)
                : null,
            expectedCheckOut:
              isWorking && sch.shift
                ? sch.shift.isOvernight
                  ? DateUtil.buildDateTime(
                      dayjs(sch.date).add(1, 'day').toDate(),
                      sch.shift.endTime,
                    )
                  : DateUtil.buildDateTime(sch.date, sch.shift.endTime)
                : null,
            status,
            lateMinutes: 0,
            earlyLeaveMin: 0,
            overtimeMinutes: 0,
            netWorkMin: 0,
            workDate: sch.date,
            note: sch.note ?? null,
            breaks: [],
            createdAt: sch.date,
            updatedAt: sch.date,
            schedule: sch,
          };
        });

      rows = [...records, ...planned].sort(
        (a, b) => a.workDate.getTime() - b.workDate.getTime(),
      );
    }

    // Ish kuni deb hisoblanadigan statuslar (dam olish/ta'til/reja kirmaydi)
    const WORKED = ['PRESENT', 'LATE', 'EARLY_LEAVE', 'LATE_EARLY'];
    const expected = rows.filter(
      (r) => WORKED.includes(r.status) || r.status === 'ABSENT',
    );

    const stats = {
      // ⚠️ "Jami kun" = ishlashi kerak bo'lgan kunlar (bugungacha).
      //    Kelgusi rejadagi kunlar (PLANNED) va dam olish kunlari kirmaydi —
      //    aks holda foizlar noto'g'ri chiqadi.
      totalDays: expected.length,
      present: rows.filter((r) => r.status === 'PRESENT').length,
      late: rows.filter((r) => ['LATE', 'LATE_EARLY'].includes(r.status))
        .length,
      absent: rows.filter((r) => r.status === 'ABSENT').length,
      earlyLeave: rows.filter((r) =>
        ['EARLY_LEAVE', 'LATE_EARLY'].includes(r.status),
      ).length,
      // Kelgusidagi rejalashtirilgan ish kunlari
      planned: rows.filter((r) => r.status === 'PLANNED').length,
      totalLateMin: records.reduce((s, r) => s + r.lateMinutes, 0),
      totalOvertimeMin: records.reduce((s, r) => s + r.overtimeMinutes, 0),
    };

    return { records: rows, stats };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: WEEKEND HELPER
  // ──────────────────────────────────────────────────────────────────────────────

  private isWeekend(date: Date): boolean {
    const day = dayjs(date).tz(TZ).day(); // 0=Yakshanba, 6=Shanba
    return day === 0 || day === 6;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: Grafik statusi → Davomat statusi
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Xodimning o'sha kundagi grafik statusiga qarab davomat statusini aniqlaydi.
   *
   * ⚠️ Bu funksiya "Grafik yo'q" bug'ini hal qiladi:
   * ilgari faqat WORKING yozuvlar hisobga olinardi, shuning uchun
   * dam olish / ta'til / kasallik kunidagi xodim "Grafik yo'q" bo'lib ko'rinardi.
   */
  private scheduleStatusToAttendance(status: ScheduleStatus): string {
    switch (status) {
      case 'DAY_OFF':
        return 'DAY_OFF';
      case 'VACATION':
        return 'VACATION';
      case 'SICK':
        return 'SICK';
      case 'HOLIDAY':
        return 'HOLIDAY';
      case 'WORKING':
      default:
        // Grafik bo'yicha ishlashi kerak edi, lekin davomat yozuvi yo'q
        return 'ABSENT';
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PUBLIC: DAILY ATTENDANCE
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Kunlik davomat ro'yxati uchun xodim maydonlari.
   *
   * ⚡ Ilgari butun Employee yozuvi (pasport, manzil, maosh, GPS...) qaytarilardi
   *    — 349 xodim × har 60 soniyada. Frontend esa faqat shu 5 maydonni
   *    ishlatadi. Javob hajmi bir necha barobar kichrayadi.
   */
  private static readonly DAILY_EMPLOYEE_SELECT = {
    id: true,
    fullName: true,
    photoUrl: true,
    employeeNo: true,
    departmentId: true,
    department: { select: { id: true, name: true } },
    position: { select: { id: true, name: true } },
  } as const;

  async getDailyAttendance(
    date: string,
    departmentId?: string,
    hospitalId?: string,
  ) {
    const workDate = DateUtil.startOfDay(date);

    // ⚠️ Shanba/Yakshanba uchun alohida qoida yo'q — kasalxonada smena
    //    grafigi yagona haqiqat manbai. Ilgari dam olish kunida grafigi
    //    WORKING bo'lgan, lekin kelmagan xodimlar ro'yxatdan butunlay
    //    tushib qolardi.

    const empFilter: any = { firedAt: null };
    if (hospitalId) empFilter.hospitalId = hospitalId;
    if (departmentId) empFilter.departmentId = departmentId;

    // 1. Haqiqiy davomat yozuvlari (har doim olinadi)
    const records = await this.prisma.attendanceRecord.findMany({
      where: { workDate, employee: empFilter },
      include: {
        employee: { select: AttendanceService.DAILY_EMPLOYEE_SELECT },
        schedule: { include: { shift: true } },
        breaks: true,
      },
      orderBy: { employee: { fullName: 'asc' } },
    });

    const attendedIds = new Set(records.map((r) => r.employeeId));

    // 2. Grafigi bor, lekin davomat yozuvi yo'q xodimlar.
    //
    //    ⚠️ MUHIM: bu yerda `status: 'WORKING'` filtri YO'Q.
    //    Ilgari faqat WORKING yozuvlar olinardi, natijada dam olish (DAY_OFF),
    //    ta'til (VACATION), kasallik (SICK) va bayram (HOLIDAY) kunidagi xodim
    //    quyidagi 4-bosqichga tushib "Grafik yo'q" bo'lib ko'rinardi.
    //    Endi grafik statusi to'g'ridan-to'g'ri davomat statusiga o'giriladi.
    const scheduledMissing = await this.prisma.schedule.findMany({
      where: {
        date: workDate,
        employeeId: { notIn: [...attendedIds] },
        employee: empFilter,
      },
      include: {
        shift: true,
        employee: { select: AttendanceService.DAILY_EMPLOYEE_SELECT },
      },
    });

    const absentVirtual = scheduledMissing.map((sch) => {
      const isWorking = sch.status === 'WORKING';
      const virtualStatus = this.scheduleStatusToAttendance(sch.status);

      return {
        // Ishlamaydigan kunlar uchun ham barqaror, lekin farqlanadigan id
        id: `${virtualStatus.toLowerCase()}-${sch.employeeId}`,
        employeeId: sch.employeeId,
        scheduleId: sch.id,
        deviceId: null,
        rawCheckInTime: null,
        rawCheckOutTime: null,
        checkIn: null,
        checkOut: null,
        lunchOut: null,
        lunchIn: null,
        lunchLateMin: 0,
        coffeeOut: null,
        coffeeIn: null,
        coffeeLateMin: 0,
        // Ishlamaydigan kunda kutilayotgan vaqt bo'lmaydi
        expectedCheckIn: !isWorking
          ? null
          : sch.shift
            ? DateUtil.buildDateTime(workDate, sch.shift.startTime)
            : new Date(workDate.getTime() + 8 * 3600 * 1000),
        expectedCheckOut: !isWorking
          ? null
          : sch.shift
            ? sch.shift.isOvernight
              ? DateUtil.buildDateTime(
                  dayjs(workDate).add(1, 'day').toDate(),
                  sch.shift.endTime,
                )
              : DateUtil.buildDateTime(workDate, sch.shift.endTime)
            : new Date(workDate.getTime() + 20 * 3600 * 1000),
        status: virtualStatus as AttendanceStatus,
        lateMinutes: 0,
        earlyLeaveMin: 0,
        overtimeMinutes: 0,
        workDate,
        note: sch.note ?? null,
        breaks: [],
        createdAt: workDate,
        updatedAt: workDate,
        employee: sch.employee,
        schedule: sch,
      };
    });

    const allVirtual = [...records, ...absentVirtual];

    // 4. Grafik yozuvi umuman yo'q xodimlar — haqiqiy "Grafik yo'q".
    //    (Dam olish / ta'til / kasallik yuqoridagi 2-bosqichda hal qilindi)
    //
    //    ⚡ Ilgari bu yerda `id: { notIn: [...300+ UUID] }` ishlatilardi —
    //    Postgres uchun juda og'ir so'rov. Endi barcha xodimlar bir marta
    //    olinadi va farq xotirada hisoblanadi.
    const allIds = new Set(allVirtual.map((r) => r.employeeId));

    const allEmployees = await this.prisma.employee.findMany({
      where: empFilter,
      select: AttendanceService.DAILY_EMPLOYEE_SELECT,
      orderBy: { fullName: 'asc' },
    });

    const noScheduleEmployees = allEmployees.filter((e) => !allIds.has(e.id));

    const noScheduleVirtual = noScheduleEmployees.map((emp) => ({
      id: `noschedule-${emp.id}`,
      employeeId: emp.id,
      scheduleId: null,
      deviceId: null,
      rawCheckInTime: null,
      rawCheckOutTime: null,
      checkIn: null,
      checkOut: null,
      lunchOut: null,
      lunchIn: null,
      lunchLateMin: 0,
      coffeeOut: null,
      coffeeIn: null,
      coffeeLateMin: 0,
      expectedCheckIn: null,
      expectedCheckOut: null,
      status: 'NO_SCHEDULE' as any,
      lateMinutes: 0,
      earlyLeaveMin: 0,
      overtimeMinutes: 0,
      workDate,
      note: "Grafik yo'q",
      breaks: [],
      createdAt: workDate,
      updatedAt: workDate,
      employee: emp,
      schedule: null,
    }));

    return [...allVirtual, ...noScheduleVirtual].sort((a, b) =>
      (a.employee as any).fullName.localeCompare((b.employee as any).fullName),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PUBLIC: CRON — Kunning oxirida grafigi bor lekin kelmaganlarni ABSENT qiladi
  // ──────────────────────────────────────────────────────────────────────────────

  async markAbsentForToday() {
    const workDate = DateUtil.startOfDay(new Date());

    // Dam olish kunida ishlatmaymiz
    if (this.isWeekend(workDate)) {
      this.logger.log('markAbsentForToday: dam olish kuni — skip');
      return { marked: 0, skipped: true, reason: 'weekend' };
    }

    // Faqat grafigi WORKING bo'lgan xodimlar
    const scheduledToday = await this.prisma.schedule.findMany({
      where: { date: workDate, status: 'WORKING' },
      select: { id: true, employeeId: true, shiftId: true, shift: true },
    });

    if (scheduledToday.length === 0) {
      return { marked: 0, skipped: false };
    }

    // Bugun allaqachon davomat yozuvi bor xodimlar
    const existingRecords = await this.prisma.attendanceRecord.findMany({
      where: { workDate },
      select: { employeeId: true },
    });
    const attendedSet = new Set(existingRecords.map((r) => r.employeeId));

    // Grafigi bor, shift mavjud, lekin kelmagan xodimlar
    const toCreate = scheduledToday
      .filter((sch) => !attendedSet.has(sch.employeeId) && sch.shift)
      .map((sch) => ({
        employeeId: sch.employeeId,
        scheduleId: sch.id,
        expectedCheckIn: DateUtil.buildDateTime(workDate, sch.shift!.startTime),
        expectedCheckOut: this.buildExpectedCheckOut(
          workDate,
          sch as any,
          null,
        ),
        workDate,
        status: 'ABSENT' as AttendanceStatus,
      }));

    if (toCreate.length > 0) {
      await this.prisma.attendanceRecord.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      this.logger.log(
        `markAbsentForToday: ${toCreate.length} xodim ABSENT belgilandi`,
      );
    }

    return { marked: toCreate.length, skipped: false };
  }

  async getWeeklyStats(employeeId: string, weekStart: string) {
    const start = DateUtil.startOfWeek(weekStart);
    return this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: start } },
    });
  }

  async manualCheckIn(employeeId: string, checkInTime: string, note?: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    const eventDate = new Date(checkInTime);
    const workDate = DateUtil.startOfDay(eventDate);
    const schedule = await this.findTodaySchedule(
      employeeId,
      workDate,
      dayjs(eventDate).tz(TZ),
    );

    const expectedCheckIn = schedule?.shift
      ? DateUtil.buildDateTime(workDate, schedule.shift.startTime)
      : DateUtil.buildDateTime(workDate, '08:00');
    const expectedCheckOut = schedule
      ? this.buildExpectedCheckOut(workDate, schedule, null)
      : new Date(workDate.getTime() + 12 * 3600 * 1000);

    const lateMinutes = this.calcLateMinutes(
      eventDate,
      expectedCheckIn,
      LATE_GRACE_MINUTES,
    );
    const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

    const existing = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, workDate },
    });

    if (existing) {
      return this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { checkIn: eventDate, lateMinutes, status, note },
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
        status,
        lateMinutes,
        note,
      },
    });
  }

  /**
  /**
   * Xodim birinchi marta ish joyini belgilaganda kasalxona GPS ni saqlash.
   * Faqat Hospital.gpsLat null bo'lsa ishlaydi (bir martalik setup).
   */
  async setHospitalGps(
    userId: string,
    lat: number,
    lng: number,
  ): Promise<{ saved: boolean; alreadySet: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { include: { hospital: true } } },
    });
    if (!user?.employee) throw new NotFoundException('Xodim profili topilmadi');

    const hospital = user.employee.hospital;
    if (!hospital) throw new NotFoundException('Kasalxona topilmadi');

    if (hospital.gpsLat != null && hospital.gpsLng != null) {
      return { saved: false, alreadySet: true };
    }

    await this.prisma.hospital.update({
      where: { id: hospital.id },
      data: { gpsLat: lat, gpsLng: lng },
    });

    this.logger.log(
      `Hospital GPS set: ${hospital.name} → (${lat}, ${lng}) by ${user.username}`,
    );
    return { saved: true, alreadySet: false };
  }

  async setEmployeeGps(
    userId: string,
    lat: number,
    lng: number,
    accuracyM?: number,
  ): Promise<{ saved: boolean; alreadySet: boolean }> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException("Joylashuv koordinatalari noto'g'ri");
    }

    // ⚠️ Telefon birinchi o'lchovni Wi-Fi/uyali antenna orqali beradi —
    //    aniqlik 500-3000 m bo'lishi mumkin. Bunday qiymat ish joyi sifatida
    //    saqlansa, xodim ish joyida turgan bo'lsa ham "uzoqda" hisoblanadi.
    if (
      accuracyM !== undefined &&
      Number.isFinite(accuracyM) &&
      accuracyM > EMPLOYEE_GPS_MAX_ACCURACY_M
    ) {
      throw new BadRequestException(
        `Joylashuv aniqligi yetarli emas (±${Math.round(accuracyM)}m). ` +
          `Ochiq joyga chiqib qayta urinib ko'ring (±${EMPLOYEE_GPS_MAX_ACCURACY_M}m dan yaxshi bo'lishi kerak).`,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });

    if (!user?.employee) throw new NotFoundException('Xodim profili topilmadi');

    const employee = user.employee;

    if (employee.gpsLat != null && employee.gpsLng != null) {
      return { saved: false, alreadySet: true };
    }

    await this.prisma.employee.update({
      where: { id: employee.id },
      data: { gpsLat: lat, gpsLng: lng },
    });

    this.logger.log(
      `Employee GPS set: ${employee.fullName} → (${lat}, ${lng}) by ${user.username}`,
    );

    return { saved: true, alreadySet: false };
  }

  // ─────────────────────────────────────────────────────────────────────────────
// QO'SHISH KERAK: attendance.service.ts ichiga, setEmployeeGps() dan keyin
// ─────────────────────────────────────────────────────────────────────────────

  /**
   * SUPER_ADMIN/ASSISTANT_ADMIN/DIRECTOR/ADMIN tomonidan: xodimning
   * (noto'g'ri/adashib) saqlangan ish joyi GPS'ini tozalaydi — shundan keyin
   * xodim ilovaga kirganda "Ish joyi manzilini belgilang" banneri qayta
   * chiqadi va u to'g'ri joyda turib qaytadan belgilashi mumkin bo'ladi.
   */
  async resetEmployeeGps(employeeId: string): Promise<{ reset: boolean }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { gpsLat: null, gpsLng: null },
    });

    this.logger.log(
      `Employee GPS reset: ${employee.fullName} (${employeeId})`,
    );

    return { reset: true };
  }

  /**
   * Mobil ilovadan GPS + selfie bilan check-in / check-out.
   * Schema yangi maydonlari: checkInSource='MOBILE', selfieUrl, gpsLat, gpsLng, gpsAccuracy.
   */
  async selfCheckIn(
    userId: string,
    dto: SelfCheckInDto,
    selfieBuffer?: Buffer,
  ): Promise<{ action: 'CHECK_IN' | 'CHECK_OUT'; attendance: any }> {
    // 1. Foydalanuvchi + xodim + tashkilot
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        employee: {
          include: { hospital: true, department: true, position: true },
        },
      },
    });
    if (!user?.employee) throw new NotFoundException('Xodim profili topilmadi');

    const employee = user.employee;

    // 2. Tashkilot blok tekshiruvi
    if (await isHospitalBlocked(this.prisma, employee.hospitalId)) {
      throw new BadRequestException(
        "Tashkilot to'lovlarini kechiktirdi, davomat yozilmayapti",
      );
    }

    // 3. Geofencing — avval Position GPS, yo'q bo'lsa Hospital GPS
    const position = employee.position as any;
    const hospital = employee.hospital as any;

    // Employee GPS ustuvor, keyin Position, keyin Hospital
    const geoLat =
      (employee as any).gpsLat ?? position?.gpsLat ?? hospital?.gpsLat;
    const geoLng =
      (employee as any).gpsLng ?? position?.gpsLng ?? hospital?.gpsLng;
    const geoRadius =
      (employee as any).gpsRadius ??
      position?.gpsRadius ??
      hospital?.gpsRadius ??
      200;

    if (
      geoLat != null &&
      geoLng != null &&
      dto.gpsLat != null &&
      dto.gpsLng != null
    ) {
      const distance = haversineMeters(dto.gpsLat, dto.gpsLng, geoLat, geoLng);
      if (distance > geoRadius) {
        const distStr = formatDistance(Math.round(distance));
        throw new BadRequestException(
          `Siz ish joyidan ${distStr} uzoqdasiz (ruxsat: ${geoRadius}m). Ish joyida bo'lgan holda check-in qiling.`,
        );
      }
      this.logger.log(
        `Geofencing OK: ${employee.fullName} — ${Math.round(distance)}m`,
      );
    }

    const eventDate = new Date();
    const tzDate = dayjs(eventDate).tz(TZ);
    const workDate = DateUtil.startOfDay(eventDate);

    // 4. Bugungi jadval
    const schedule = await this.findTodaySchedule(
      employee.id,
      workDate,
      tzDate,
    );
    const fallbackShift = !schedule
      ? await this.findFallbackShift(employee.hospitalId, tzDate)
      : null;

    // 4. Selfie saqlash (ish joyi isboti sifatida)
    let selfieUrl: string | undefined;
    if (selfieBuffer?.length) {
      const uploadDir = path.join(
        process.env.UPLOAD_DIR || './uploads',
        'selfies',
      );
      const base = `${dayjs(workDate).format('YYYY-MM-DD')}-${employee.id.slice(-8)}`;
      const { filename } = await processAndSavePhoto(
        selfieBuffer,
        uploadDir,
        base,
      );
      selfieUrl = `/uploads/selfies/${filename}`;
    }

    // 5. Mavjud davomat yozuvi
    const existing = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId: employee.id, workDate },
    });

    // ── CHECK-IN ───────────────────────────────────────────────────────────────
    if (!existing || !existing.checkIn) {
      const expectedCheckIn = this.buildExpectedCheckIn(
        workDate,
        schedule,
        fallbackShift,
      );
      const expectedCheckOut = this.buildExpectedCheckOut(
        workDate,
        schedule,
        fallbackShift,
      );
      const graceMin =
        schedule?.shift?.graceMinutes ??
        fallbackShift?.graceMinutes ??
        LATE_GRACE_MINUTES;
      const lateMinutes = this.resolveLateMinutes(
        eventDate,
        expectedCheckIn,
        graceMin,
        !schedule, // grafik yo'q → smena taxmin qilingan
        employee.fullName,
      );
      const status: AttendanceStatus = lateMinutes > 0 ? 'LATE' : 'PRESENT';

      // GPS — xodim hozir qayerda ekanini saqlaydi (geofencing yo'q, faqat dalil)
      const gpsData = {
        checkInSource: 'MOBILE',
        selfieUrl: selfieUrl ?? existing?.selfieUrl ?? undefined,
        gpsLat: dto.gpsLat,
        gpsLng: dto.gpsLng,
        gpsAccuracy: dto.gpsAccuracy,
      };

      let attendance: any;
      if (existing) {
        attendance = await this.prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            checkIn: eventDate,
            rawCheckInTime: eventDate,
            expectedCheckIn,
            expectedCheckOut,
            status,
            lateMinutes,
            ...gpsData,
          },
        });
      } else {
        attendance = await this.prisma.attendanceRecord.create({
          data: {
            employeeId: employee.id,
            scheduleId: schedule?.id,
            checkIn: eventDate,
            rawCheckInTime: eventDate,
            expectedCheckIn,
            expectedCheckOut,
            workDate,
            status,
            lateMinutes,
            ...gpsData,
          },
        });
      }

      await this.updateWeeklyStats(
        employee.id,
        eventDate,
        lateMinutes,
        0,
        0,
        true,
      );
      this.logger.log(
        `MOBILE CHECK_IN: ${employee.fullName ?? employee.id} late=${lateMinutes}min gps=(${dto.gpsLat},${dto.gpsLng})`,
      );

      // Telegram: selfie + Google Maps havolasi → directorga yuboriladi (async, xatolik to'xtatmaydi)
      this.telegram
        .notifyMobileCheckin(employee, 'CHECK_IN', attendance, selfieBuffer)
        .catch((e) => this.logger.warn(`Telegram notify failed: ${e.message}`));

      this.emitAttendanceEvent(employee, 'CHECK_IN', attendance);

      return { action: 'CHECK_IN' as const, attendance };
    }

    // ── CHECK-OUT ──────────────────────────────────────────────────────────────
    if (!existing.checkOut) {
      // Minimum 2 soat o'tganligini tekshirish
      if (existing.checkIn) {
        const minutesSinceCheckIn =
          (eventDate.getTime() - existing.checkIn.getTime()) / 60_000;
        if (minutesSinceCheckIn < 120) {
          const remaining = Math.ceil(120 - minutesSinceCheckIn);
          throw new BadRequestException(
            `Check-out hali erta. ${remaining} daqiqa kutish kerak (minimum 2 soat ish vaqti).`,
          );
        }
      }

      const expectedEnd =
        existing.expectedCheckOut ??
        this.buildExpectedCheckOut(workDate, schedule, fallbackShift);
      const earlyLeaveMin = this.calcEarlyLeaveMinutes(eventDate, expectedEnd);
      const overtimeMinutes = this.calcOvertimeMinutes(eventDate, expectedEnd);
      const shift = schedule?.shift ?? fallbackShift;
      const netWorkMin = calcNetWorkMin(
        existing.checkIn!,
        eventDate,
        existing.lunchOut,
        existing.lunchIn,
        shift?.lunchStart,
        shift?.lunchEnd,
      );
      const newStatus = this.recalcStatus(
        existing.status,
        existing.lateMinutes,
        earlyLeaveMin,
      );

      // Check-out selfie saqlash
      let checkOutSelfieUrl: string | undefined;
      if (selfieBuffer?.length) {
        const uploadDir = path.join(
          process.env.UPLOAD_DIR || './uploads',
          'selfies',
        );
        const base = `checkout-${dayjs(workDate).format('YYYY-MM-DD')}-${employee.id.slice(-8)}`;
        const { filename } = await processAndSavePhoto(
          selfieBuffer,
          uploadDir,
          base,
        );
        checkOutSelfieUrl = `/uploads/selfies/${filename}`;
      }

      const attendance = await this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          checkOut: eventDate,
          rawCheckOutTime: eventDate,
          earlyLeaveMin,
          overtimeMinutes,
          netWorkMin,
          status: newStatus,
          checkOutSelfieUrl,
          checkOutGpsLat: dto.gpsLat,
          checkOutGpsLng: dto.gpsLng,
          checkOutGpsAccuracy: dto.gpsAccuracy,
        },
      });

      // Live xaritadan darhol olib tashlash
      this.locationGateway.broadcastLocationRemoved(
        employee.hospitalId,
        userId,
      );

      await this.updateWeeklyStats(
        employee.id,
        eventDate,
        0,
        earlyLeaveMin,
        overtimeMinutes,
      );
      this.logger.log(
        `MOBILE CHECK_OUT: ${employee.fullName ?? employee.id} gps=(${dto.gpsLat},${dto.gpsLng})`,
      );

      // Telegram: check-out selfie + GPS bilan xabar
      this.telegram
        .notifyMobileCheckin(employee, 'CHECK_OUT', attendance, selfieBuffer)
        .catch((e) => this.logger.warn(`Telegram notify failed: ${e.message}`));

      this.emitAttendanceEvent(employee, 'CHECK_OUT', attendance);

      return { action: 'CHECK_OUT' as const, attendance };
    }

    // ── Allaqachon yakunlangan ─────────────────────────────────────────────────
    throw new BadRequestException('Bugun uchun davomat allaqachon yakunlangan');
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: SCHEDULE HELPERS
  // ──────────────────────────────────────────────────────────────────────────────

  private async findTodaySchedule(
    employeeId: string,
    workDate: Date,
    eventTz: Dayjs,
  ) {
    let schedule = await this.prisma.schedule.findUnique({
      where: { employeeId_date: { employeeId, date: workDate } },
      include: { shift: true },
    });

    // Tungi smena: soat 10 dan oldin bo'lsa — kechagi jadvalga qaraydi
    if (!schedule && eventTz.hour() < 10) {
      const yesterday = DateUtil.startOfDay(
        dayjs(workDate).subtract(1, 'day').toDate(),
      );
      const ySch = await this.prisma.schedule.findUnique({
        where: { employeeId_date: { employeeId, date: yesterday } },
        include: { shift: true },
      });
      if (ySch?.shift?.isOvernight) schedule = ySch;
    }

    return schedule?.status === 'WORKING' ? schedule : null;
  }

  /**
   * Grafigi yo'q xodim uchun smenani TAXMIN qiladi.
   *
   * ⚠️ Ilgari qo'pol qoida ishlatilardi:
   *     soat < 10 bo'lsa tungi, aks holda kunduzgi.
   *   Natijada kechki smenaga 19:00 da kelgan xodimga kunduzgi (08:00)
   *   smena berilardi va u ~660 daqiqa "kechikkan" bo'lib chiqardi —
   *   direktorga esa noto'g'ri "kechikdi" xabari ketardi.
   *   Teskarisi ham: 07:00 da kelgan kunduzgi xodimga tungi smena berilardi.
   *
   * Endi kelish vaqtiga eng YAQIN boshlanish vaqtli smena tanlanadi
   * (sutka aylanasi hisobga olinadi). Smenadan biroz oldin kelish tabiiy,
   * shuning uchun erta kelishga yumshoqroq baho beriladi.
   */
  private async findFallbackShift(hospitalId: string | null, eventTz: Dayjs) {
    if (!hospitalId) return null;
    const shifts = await this.prisma.shiftTemplate.findMany({
      where: { hospitalId },
    });
    if (!shifts.length) return null;

    const arrivalMin = eventTz.hour() * 60 + eventTz.minute();

    let best: (typeof shifts)[number] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const s of shifts) {
      const [h, m] = (s.startTime ?? '00:00').split(':').map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;

      // Kelish va smena boshlanishi orasidagi eng qisqa masofa (±12 soat)
      let diff = arrivalMin - (h * 60 + m); // musbat = kech, manfiy = erta
      if (diff > 720) diff -= 1440;
      if (diff < -720) diff += 1440;

      // Xodim smenadan bir necha SOAT oldin kelmaydi — lekin smena
      // boshlangandan keyin skanerlash odatiy holat (kech kelish yoki
      // smena o'rtasida qayta o'tish). Shuning uchun "kech" tomon arzonroq
      // baholanadi: masalan 02:00 dagi o'tish 20:00 da boshlangan tungi
      // smenaga tegishli, 08:00 kunduzgiga 6 soat erta kelish emas.
      const score = diff >= 0 ? diff * 0.5 : Math.abs(diff);

      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }

    return best ?? shifts[0];
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PRIVATE: CALCULATION HELPERS
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Haversine formula — ikki koordinata orasidagi masofa (metr).
   */
  private calcHaversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6_371_000; // Yer radiusi, metr
    const d2r = Math.PI / 180;
    const φ1 = lat1 * d2r;
    const φ2 = lat2 * d2r;
    const Δφ = (lat2 - lat1) * d2r;
    const Δλ = (lng2 - lng1) * d2r;
    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  private buildExpectedCheckIn(
    workDate: Date,
    schedule: any | null,
    fallbackShift: any | null,
  ): Date {
    const startTime =
      schedule?.shift?.startTime ?? fallbackShift?.startTime ?? '08:00';
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
      return DateUtil.buildDateTime(
        dayjs(workDate).add(1, 'day').toDate(),
        shift.endTime,
      );
    }
    return DateUtil.buildDateTime(workDate, shift.endTime);
  }

  /**
   * Kechikishni hisoblaydi. Smena TAXMIN qilingan bo'lsa (grafik yo'q),
   * haddan tashqari katta natija taxminning xatosi deb qabul qilinadi
   * va kechikish qayd etilmaydi.
   */
  private resolveLateMinutes(
    checkIn: Date,
    expected: Date,
    graceMin: number,
    isGuessedShift: boolean,
    employeeName?: string,
  ): number {
    const late = this.calcLateMinutes(checkIn, expected, graceMin);

    if (isGuessedShift && late > MAX_GUESSED_LATE_MIN) {
      this.logger.warn(
        `${employeeName ?? 'Xodim'}: grafigi yo'q, taxmin qilingan smena ` +
          `${late} daqiqa kechikish beryapti — taxmin noto'g'ri deb hisoblanib ` +
          `kechikish yozilmadi. Xodimga grafik biriktiring.`,
      );
      return 0;
    }

    return late;
  }

  private calcLateMinutes(
    checkIn: Date,
    expected: Date,
    graceMin: number,
  ): number {
    const diff = DateUtil.diffMinutes(checkIn, expected);
    return diff <= graceMin ? 0 : diff - graceMin;
  }

  private calcEarlyLeaveMinutes(
    checkOut: Date,
    expectedEnd: Date | null,
  ): number {
    if (!expectedEnd) return 0;
    // Sanalar bir xil kunda bo'lishi kerak — boshqa kunda bo'lsa ignore
    const sameDay =
      DateUtil.startOfDay(checkOut).getTime() ===
      DateUtil.startOfDay(expectedEnd).getTime();
    if (!sameDay) return 0;
    return Math.max(0, DateUtil.diffMinutes(expectedEnd, checkOut));
  }

  private calcOvertimeMinutes(
    checkOut: Date,
    expectedEnd: Date | null,
  ): number {
    if (!expectedEnd) return 0;
    const sameDay =
      DateUtil.startOfDay(checkOut).getTime() ===
      DateUtil.startOfDay(expectedEnd).getTime();
    if (!sameDay) return 0;
    return Math.max(0, DateUtil.diffMinutes(checkOut, expectedEnd));
  }

  private calcLunchLateMinutes(
    returnTime: Date,
    lunchEnd?: string | null,
    graceMin = 10,
  ): number {
    if (!lunchEnd) return 0;
    const [h, m] = lunchEnd.split(':').map(Number);
    const tzReturn = dayjs(returnTime).tz(TZ);
    const lunchEndDt = tzReturn.startOf('day').add(h * 60 + m, 'minute');
    const diff = tzReturn.diff(lunchEndDt, 'minute');
    return diff <= graceMin ? 0 : diff - graceMin;
  }

  private isNearLunchStart(eventTime: Date, lunchStart: string): boolean {
    const [h, m] = lunchStart.split(':').map(Number);
    const tzEvent = dayjs(eventTime).tz(TZ);
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
    if (earlyMin > 0) return 'EARLY_LEAVE';
    if (lateMin > 0) return 'LATE';
    return current === 'ABSENT' ? 'PRESENT' : current;
  }

  private async updateWeeklyStats(
    employeeId: string,
    date: Date,
    addLateMin: number,
    addEarlyMin: number,
    addOvertime: number,
    isCheckIn = false, // faqat check-in da daysWorked oshadi
  ) {
    const weekStart = DateUtil.startOfWeek(date);
    const weekEnd = DateUtil.endOfWeek(date);

    const existing = await this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart } },
    });

    const prevLate = existing?.totalLateMin ?? 0;
    const newLate = prevLate + addLateMin;
    const penaltyLateMin = Math.max(0, newLate - WEEKLY_LATE_THRESHOLD_MIN);

    let deductionAmount = 0;
    if (penaltyLateMin > 0) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { baseSalary: true },
      });
      if (emp) {
        const monthWorkMinutes = 26 * 8 * 60;
        const minuteRate = Number(emp.baseSalary) / monthWorkMinutes;
        const addedPenalty = penaltyLateMin - (existing?.penaltyLateMin ?? 0);
        deductionAmount =
          (existing ? Number(existing.deductionAmount) : 0) +
          addedPenalty * minuteRate;
      }
    }

    await this.prisma.weeklyAttendanceStat.upsert({
      where: { employeeId_weekStart: { employeeId, weekStart } },
      update: {
        totalLateMin: { increment: addLateMin },
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
        totalLateMin: addLateMin,
        totalEarlyMin: addEarlyMin,
        totalOvertime: addOvertime,
        daysWorked: isCheckIn ? 1 : 0, // har doim check-in da 1 dan boshlaydi
        penaltyLateMin,
        deductionAmount,
      },
    });
  }
}

// ─── INTERNAL TYPE ───────────────────────────────────────────────────────────

/** dispatch() ga uzatiladigan kontekst */
interface EventContext {
  employee: any;
  eventDate: Date;
  workDate: Date;
  tzDate: Dayjs;
  schedule: any | null;
  fallbackShift: any | null;
  shift: any | null;
  attendance: any | null;
  deviceId?: string;
}
