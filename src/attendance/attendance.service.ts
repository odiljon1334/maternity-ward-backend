import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
import * as fs from 'fs';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { FaceMatchService } from '../face-match/face-match.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { applyNoticeExcuse } from '../attendance-notices/notice-excuse.util';
import { PushService } from '../push/push.service';
import { DateUtil } from '../common/utils/date.util';
import { isHospitalBlocked } from '../common/utils/payment.util';
import { calcNetWorkMin } from '../common/utils/shift.util';
import { formatDistance } from '../common/utils/geo.util';
import { buildGeoCenters, matchGeoCenter } from '../work-sites/geofence.util';
import {
  prepareFaceImage,
  processAndSavePhoto,
} from '../common/utils/image.util';
import { LATE_GRACE_MINUTES } from '../common/constants';
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
 * Mobil check-in GPS aniqligi (FAZA 6, 4c — Odiljon, 2026-09-23):
 *  - telefon bergan aniqlik (accuracy) geofence radiusiga ko'pi bilan 50 m
 *    qo'shiladi — ±2 km taxminiy nuqta bilan chetlab o'tib bo'lmaydi;
 *  - 150 m dan yomon aniqlikdagi o'lchov umuman qabul qilinmaydi.
 */
const MOBILE_GPS_TOLERANCE_MAX_M = 50;
const MOBILE_GPS_MAX_ACCURACY_M = 150;

/** Check-out'da jonli kuzatuv shu daqiqadan ko'p uzilgan bo'lsa — yuz tekshiriladi */
const CHECKOUT_TRACKING_GAP_MIN = 30;

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

export interface AutoClosedAttendance {
  recordId: string;
  employeeId: string;
  employeeName: string;
  hospitalId: string;
  expectedCheckOut: Date;
}

// ─── SERVICE ──────────────────────────────────────────────────────────────────

/**
 * Tungi smena: kechagi ochiq yozuv (kelgan, ketmagan) shu vaqt ichida
 * "hozirgi smena" hisoblanadi — kelishdan 20 soat va kutilgan ketishdan
 * 8 soat o'tmagan bo'lsa.
 */
const OVERNIGHT_OPEN_MAX_MS = 20 * 3600_000;
const OVERNIGHT_AFTER_END_MS = 8 * 3600_000;

/** Check-in'ni to'xtatmaydigan (xodimga bog'liq bo'lmagan) yuz tekshiruvi sabablari */
export const DEFERRABLE_FACE_REASONS = new Set([
  'SERVICE_ERROR',
  'NO_REFERENCE_PHOTO',
  'REFERENCE_FACE_NOT_FOUND',
]);

interface FaceCheckOutcome {
  /** Yuz profil rasmi bilan mos keldi */
  verified: boolean;
  /** Tekshirib bo'lmadi — check-in qabul qilindi, keyinroq qayta tekshiriladi */
  deferred: boolean;
  reason: string | null;
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly locationGateway: LocationGateway,
    private readonly faceMatch: FaceMatchService,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly push?: PushService,
  ) {}

  /**
   * Kun oxirigacha check-out qilinmagan, smenasi tugagan davomatlarni yopadi.
   * Haqiqiy chiqish vaqti noma'lum bo'lgani uchun grafik tugash vaqti olinadi
   * va overtime hisoblanmaydi. updateMany terminal bilan bir vaqtda kelgan
   * check-outni ustidan yozib yubormaslik uchun ishlatiladi.
   */
  async autoCloseMissingCheckouts(
    at: Date = new Date(),
  ): Promise<AutoClosedAttendance[]> {
    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        expectedCheckOut: {
          gte: DateUtil.startOfDay(at),
          lte: at,
        },
        checkIn: { not: null },
        checkOut: null,
        status: { not: AttendanceStatus.ABSENT },
      },
      include: {
        schedule: { include: { shift: true } },
        employee: {
          include: {
            department: true,
            position: true,
            hospital: true,
          },
        },
      },
    });

    const closed: AutoClosedAttendance[] = [];

    for (const record of records) {
      const shift = record.schedule?.shift;
      const netWorkMin = calcNetWorkMin(
        record.checkIn!,
        record.expectedCheckOut,
        record.lunchOut,
        record.lunchIn,
        shift?.lunchStart,
        shift?.lunchEnd,
      );
      const status = this.recalcStatus(record.status, record.lateMinutes, 0);

      const updated = await this.prisma.attendanceRecord.updateMany({
        where: { id: record.id, checkOut: null },
        data: {
          checkOut: record.expectedCheckOut,
          earlyLeaveMin: 0,
          overtimeMinutes: 0,
          netWorkMin,
          status,
          checkOutSource: 'AUTO',
          autoCheckOut: true,
        },
      });

      if (updated.count === 0) continue;

      if (record.employee.userId) {
        this.locationGateway.broadcastLocationRemoved(
          record.employee.hospitalId,
          record.employee.userId,
        );
      }

      closed.push({
        recordId: record.id,
        employeeId: record.employeeId,
        employeeName: record.employee.fullName,
        hospitalId: record.employee.hospitalId,
        expectedCheckOut: record.expectedCheckOut,
      });
    }

    return closed;
  }

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

    // 1b. Terminal boshqa muassasaniki bo'lsa — rad etiladi. Webhook secret
    // barcha muassasalar uchun bitta: bir muassasa terminali (yoki secret'ni
    // bilgan kishi) boshqa muassasa xodimiga davomat yoza olmasin. deviceId
    // ro'yxatdagi terminalga mos kelmasa (format farq qilishi mumkin) —
    // faqat log, event o'tkaziladi.
    if (deviceId) {
      const terminal = await this.prisma.hikTerminal.findUnique({
        where: { devIndex: deviceId },
        select: { hospitalId: true },
      });
      if (terminal && terminal.hospitalId !== employee.hospitalId) {
        this.logger.warn(
          `Terminal ${deviceId} (muassasa ${terminal.hospitalId}) boshqa muassasa xodimi ${employeeNo} uchun event yubordi — rad etildi`,
        );
        return null;
      }
      if (!terminal) {
        this.logger.debug?.(
          `Webhook deviceId=${deviceId} ro'yxatdagi terminallarga mos emas`,
        );
      }
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
        `raw="${eventTime ?? "yo'q"}" | ` +
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
        // ⚠️ SUPER_ADMIN 'super-admins' xonasida BARCHA kasalxonalar
        //    hodisasini oladi. Frontend faqat tanlangan kasalxonanikini
        //    ko'rsatishi uchun bu maydon SHART.
        hospitalId: employee.hospitalId ?? null,
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
    // Xodimning o'ziga shaxsiy Telegram xabari (terminal va ilova uchun
    // yagona joy — takroriy skanerlar bu yerga yetib kelmaydi)
    this.telegram
      ?.notifyEmployeeAttendance?.(employee, action, attendance)
      ?.catch?.(() => {});
    // Oldindan tasdiqlangan "Kechikaman" xabari bo'lsa — kechikish uzrli
    if (
      action === 'CHECK_IN' &&
      attendance?.workDate &&
      attendance.lateMinutes > 0
    ) {
      applyNoticeExcuse(this.prisma, employee.id, attendance.workDate).catch(
        () => {},
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
    await this.updateWeeklyStats(
      employee.id,
      eventDate,
      lateMinutes,
      0,
      0,
      true,
    );

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
        checkOutSource: 'TERMINAL',
        autoCheckOut: false,
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
    opts: { includePlanned?: boolean; hospitalId?: string | null } = {},
  ) {
    if (opts.hospitalId) {
      await this.ensureEmployeeInHospital(employeeId, opts.hospitalId);
    }
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

      const recordDays = new Set(records.map((r) => r.workDate.getTime()));
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
      case 'MATERNITY_LEAVE':
        return 'MATERNITY_LEAVE';
      case 'TRAINING':
        return 'TRAINING';
      case 'OTHER_ABSENCE':
        return 'OTHER_ABSENCE';
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

  /**
   * Bugun kelmaganlarni ABSENT qiladi. `hospitalId` berilsa — faqat shu
   * muassasa (qo'lda chaqirilganda). Berilmasa (cron) — barcha muassasalar.
   * XAVFSIZLIK (3-paket): ilgari ADMIN qo'lda bosganda ham BARCHA
   * muassasalar xodimlari "kelmadi" bo'lardi.
   */
  async markAbsentForToday(hospitalId?: string | null) {
    const workDate = DateUtil.startOfDay(new Date());
    const scope = hospitalId ? { employee: { hospitalId } } : {};

    // Dam olish kunida ishlatmaymiz
    if (this.isWeekend(workDate)) {
      this.logger.log('markAbsentForToday: dam olish kuni — skip');
      return { marked: 0, skipped: true, reason: 'weekend' };
    }

    // Faqat grafigi WORKING bo'lgan xodimlar
    const scheduledToday = await this.prisma.schedule.findMany({
      where: { date: workDate, status: 'WORKING', ...scope },
      select: { id: true, employeeId: true, shiftId: true, shift: true },
    });

    if (scheduledToday.length === 0) {
      return { marked: 0, skipped: false };
    }

    // Bugun allaqachon davomat yozuvi bor xodimlar
    const existingRecords = await this.prisma.attendanceRecord.findMany({
      where: { workDate, ...scope },
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

  async getWeeklyStats(
    employeeId: string,
    weekStart: string,
    hospitalId?: string | null,
  ) {
    if (hospitalId) {
      await this.ensureEmployeeInHospital(employeeId, hospitalId);
    }
    const start = DateUtil.startOfWeek(weekStart);
    return this.prisma.weeklyAttendanceStat.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: start } },
    });
  }

  async manualCheckIn(
    employeeId: string,
    checkInTime: string,
    note?: string,
    hospitalId?: string | null,
  ) {
    // XAVFSIZLIK (3-paket): faqat o'z muassasasi xodimi
    const emp = await this.prisma.employee.findFirst({
      where: { id: employeeId, ...(hospitalId && { hospitalId }) },
    });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    const eventDate = new Date(checkInTime);
    if (Number.isNaN(eventDate.getTime())) {
      throw new BadRequestException("Kelish vaqti noto'g'ri");
    }
    if (eventDate.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException(
        "Kelish vaqti kelajakda bo'lishi mumkin emas",
      );
    }
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
   * Yuz tekshiruvi (Qaror 4). Rasmlar oldin 640px gacha kichraytiriladi;
   * har bir bosqich vaqti log'ga yoziladi (face-match tezligini o'lchash).
   * Mos kelmasa BadRequestException. Check-out'da xizmat ishlamasa —
   * bloklanmaydi (xodim ishdan keta olmay qolmasligi uchun), faqat log.
   */
  private async verifyFaceOrThrow(
    userId: string,
    employee: { id: string; hospitalId: string; photoUrl: string | null },
    selfie: Buffer,
    stage: 'CHECK_IN' | 'CHECK_OUT',
  ): Promise<FaceCheckOutcome> {
    const t0 = Date.now();
    let referenceRaw: Buffer | null = null;
    if (employee.photoUrl) {
      try {
        const refPath = path.join(
          process.env.UPLOAD_DIR || './uploads',
          employee.photoUrl.replace(/^\/uploads\//, ''),
        );
        if (fs.existsSync(refPath)) referenceRaw = fs.readFileSync(refPath);
      } catch (e: any) {
        this.logger.warn(`Profil rasmini o'qib bo'lmadi: ${e?.message ?? e}`);
      }
    }
    const [reference, live] = await Promise.all([
      referenceRaw ? prepareFaceImage(referenceRaw) : Promise.resolve(null),
      prepareFaceImage(selfie),
    ]);
    const t1 = Date.now();
    const faceResult = await this.faceMatch.verify(reference, live);
    const t2 = Date.now();

    this.logger.log(
      `Face-match ${stage}: employee=${employee.id} prep=${t1 - t0}ms verify=${t2 - t1}ms ` +
        `selfie=${Math.round(selfie.length / 1024)}→${Math.round(live.length / 1024)}KB ` +
        `ref=${reference ? Math.round(reference.length / 1024) : 0}KB ` +
        `result=${faceResult.mismatch ? 'MISMATCH' : faceResult.skipped ? 'SKIPPED' : 'OK'}${faceResult.reason ? `/${faceResult.reason}` : ''}`,
    );

    const reason = faceResult.reason ?? null;
    // Xodimga bog'liq bo'lmagan sabablar (xizmat ishlamadi, profil rasmi yo'q
    // yoki unda yuz topilmadi):
    //  - check-in: butun muassasa davomati to'xtab qolmasligi uchun qabul
    //    qilinadi, yuz keyinroq fon vazifasida tekshiriladi (FaceRecheckService).
    //    GPS baribir majburiy, selfie saqlanadi. FACE_MATCH_FALLBACK=block —
    //    eski qat'iy xulq (rad etish).
    //  - check-out: har doim o'tkaziladi — rasmsiz qabul qilingan xodim
    //    ishdan keta olmay qolmasin.
    const external =
      faceResult.mismatch && DEFERRABLE_FACE_REASONS.has(reason ?? '');
    const defer =
      external &&
      stage === 'CHECK_IN' &&
      process.env.FACE_MATCH_FALLBACK !== 'block';
    const tolerateCheckout = external && stage === 'CHECK_OUT';

    // Audit — bitta yozuv (ilgari kechiktirilgan holat avval REJECTED, keyin
    // DEFERRED bo'lib ikki marta yozilardi)
    this.auditLog.log({
      userId,
      hospitalId: employee.hospitalId,
      action: defer
        ? 'FACE_MATCH_DEFERRED'
        : tolerateCheckout || faceResult.skipped
          ? 'FACE_MATCH_SKIPPED'
          : faceResult.mismatch
            ? 'FACE_MATCH_REJECTED'
            : 'FACE_MATCH_OK',
      entity: 'AttendanceRecord',
      entityId: employee.id,
      details: {
        stage,
        employeeId: employee.id,
        reason,
        similarity: faceResult.similarity,
        prepMs: t1 - t0,
        verifyMs: t2 - t1,
      },
    });

    if (!faceResult.mismatch) {
      return { verified: !faceResult.skipped, deferred: false, reason };
    }
    if (tolerateCheckout) {
      this.logger.warn(
        `Yuz tekshirib bo'lmadi (${reason}) — check-out bloklanmadi: employee=${employee.id}`,
      );
      return { verified: false, deferred: false, reason };
    }
    if (defer) {
      this.logger.warn(
        `Face-match kechiktirildi (${reason}) — check-in qabul qilindi, keyinroq tekshiriladi: employee=${employee.id}`,
      );
      return { verified: false, deferred: true, reason };
    }

    const action = stage === 'CHECK_IN' ? 'check-in' : 'check-out';
    const MESSAGES: Record<string, string> = {
      FACE_MISMATCH: `Yuz tasdiqlanmadi — ${action} rad etildi. Iltimos, yaxshi yorug'likda, kamerani to'g'ridan qarab qaytadan urinib ko'ring.`,
      LIVE_FACE_NOT_FOUND: `Suratda yuzingiz aniqlanmadi — ${action} rad etildi. Iltimos, yorug'roq joyda, yuzingizni kameraga to'g'ridan qaratib qaytadan urinib ko'ring.`,
      REFERENCE_FACE_NOT_FOUND: `Profil rasmingizda yuz aniqlanmadi — ${action} rad etildi. Iltimos, administratorga murojaat qiling.`,
      NO_REFERENCE_PHOTO:
        'Profilingizda rasm mavjud emas — yuz tasdiqlash uchun avval profilga rasm yuklashingiz kerak. Administratorga murojaat qiling.',
      SERVICE_ERROR: `Yuz tekshirish xizmati vaqtincha ishlamayapti — ${action} rad etildi. Birozdan so'ng qaytadan urinib ko'ring yoki administratorga murojaat qiling.`,
    };
    throw new BadRequestException(
      MESSAGES[faceResult.reason ?? ''] ?? MESSAGES.FACE_MISMATCH,
    );
  }

  /**
   * Check-out'da yuz kerakmi: smena davomida jonli kuzatuv xodimni ish
   * joyidan tashqarida ko'rgan, yoki oxirgi GPS nuqtasi 30 daqiqadan eski
   * (yoki umuman yo'q) bo'lsa — ha.
   */
  private async checkoutNeedsFaceMatch(
    userId: string,
    checkIn: Date,
  ): Promise<boolean> {
    const [outside, last] = await Promise.all([
      this.prisma.liveLocation.count({
        where: { userId, createdAt: { gte: checkIn }, isOutside: true },
      }),
      this.prisma.liveLocation.findFirst({
        where: { userId, createdAt: { gte: checkIn } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    if (outside > 0 || !last) return true;
    return (
      Date.now() - last.createdAt.getTime() > CHECKOUT_TRACKING_GAP_MIN * 60_000
    );
  }

  /**
   * SUPER_ADMIN/ASSISTANT_ADMIN/DIRECTOR/ADMIN tomonidan: xodimning
   * (noto'g'ri/adashib) saqlangan shaxsiy ish joyi GPS'ini tozalaydi —
   * shundan keyin xodim lavozim/muassasa markazi bo'yicha tekshiriladi.
   */
  async resetEmployeeGps(
    employeeId: string,
    hospitalId?: string | null,
  ): Promise<{ reset: boolean }> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, ...(hospitalId && { hospitalId }) },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { gpsLat: null, gpsLng: null },
    });

    this.logger.log(`Employee GPS reset: ${employee.fullName} (${employeeId})`);

    return { reset: true };
  }

  private async ensureEmployeeInHospital(
    employeeId: string,
    hospitalId: string,
  ): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, hospitalId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');
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
          include: {
            hospital: true,
            department: true,
            position: true,
            workSites: { include: { workSite: true } },
          },
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

    // XAVFSIZLIK (2026-09-23 audit): koordinata MAJBURIY. Ilgari GPS
    // yuborilmasa masofa tekshiruvi umuman o'tkazilmasdi va istalgan joydan
    // check-in qilish mumkin edi.
    if (
      !Number.isFinite(dto.gpsLat) ||
      !Number.isFinite(dto.gpsLng) ||
      Math.abs(dto.gpsLat as number) > 90 ||
      Math.abs(dto.gpsLng as number) > 180
    ) {
      throw new BadRequestException(
        "Joylashuv aniqlanmadi. Telefoningizda GPS (joylashuv) ruxsatini yoqib, qaytadan urinib ko'ring.",
      );
    }

    // 2b. Soxta joylashuv (Fake GPS). Rad etiladi va rahbariyat xabardor
    //     qilinadi — xodim ilovani o'chirib, qayta urinishi mumkin.
    if (dto.mocked === true) {
      const context =
        dto.expectedAction === 'CHECK_OUT' ? 'CHECK_OUT' : 'CHECK_IN';
      this.auditLog.log({
        userId,
        hospitalId: employee.hospitalId,
        action: 'MOCK_LOCATION_REJECTED',
        entity: 'AttendanceRecord',
        entityId: employee.id,
        details: {
          employeeId: employee.id,
          context,
          gpsLat: dto.gpsLat,
          gpsLng: dto.gpsLng,
        },
      });
      this.push
        ?.notifyMockLocation(
          employee.hospitalId,
          employee.id,
          employee.fullName ?? 'Xodim',
          context,
        )
        .then((sent) => {
          if (sent) {
            this.telegram.notifyMockLocation(employee, context).catch(() => {});
          }
        })
        .catch(() => {});
      throw new BadRequestException(
        "Telefoningizda soxta joylashuv (Fake GPS) ilovasi yoqilgan. Uni o'chirib, qayta urinib ko'ring. Rahbariyatga xabar yuborildi.",
      );
    }

    // 3. Geofence (FAZA 6, 4b): biriktirilgan ish joylari + eski shaxsiy
    //    markaz + asosiy bino — ISTALGANI ichida bo'lsa ruxsat.
    const geoCenters = buildGeoCenters({
      employee,
      position: employee.position,
      hospital: employee.hospital,
      sites: (employee.workSites ?? []).map((w) => w.workSite),
    });
    const accuracy = Number.isFinite(dto.gpsAccuracy)
      ? Math.max(0, dto.gpsAccuracy as number)
      : 0;
    if (accuracy > MOBILE_GPS_MAX_ACCURACY_M) {
      throw new BadRequestException(
        `Joylashuv aniqligi past (±${Math.round(accuracy)} m). Ochiqroq joyga chiqib, bir necha soniya kuting va qayta urinib ko'ring.`,
      );
    }
    const geoMatch = matchGeoCenter(
      geoCenters,
      dto.gpsLat as number,
      dto.gpsLng as number,
      Math.min(accuracy, MOBILE_GPS_TOLERANCE_MAX_M),
    );

    if (!geoMatch) {
      // Hech qanday markaz belgilanmagan — tekshirib bo'lmaydi.
      // Direktor/Admin Sozlamalar → "Check-in hududi" orqali belgilashi kerak.
      this.logger.warn(
        `Geofence markazi yo'q: hospital=${employee.hospitalId} — masofa tekshirilmadi`,
      );
    } else if (!geoMatch.inside) {
      const distStr = formatDistance(Math.round(geoMatch.distance));
      const place =
        geoCenters.length > 1
          ? `eng yaqin ish joyi «${geoMatch.center.name}»dan`
          : 'ish joyidan';
      throw new BadRequestException(
        `Siz ${place} ${distStr} uzoqdasiz (ruxsat: ${geoMatch.center.radius}m). Ish joyida bo'lgan holda check-in qiling.`,
      );
    } else {
      this.logger.log(
        `Geofencing OK: employee=${employee.id} — ${geoMatch.center.source} ${Math.round(geoMatch.distance)}m`,
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

    // 4. Mavjud davomat yozuvi (CHECK-IN/CHECK-OUT'ni aniqlash uchun oldindan kerak).
    //    Tungi smena yarim tundan o'tgan bo'lsa — kechagi ochiq yozuv.
    const target = await this.findSelfTarget(employee.id, eventDate);
    const existing = target.existing;
    const recordWorkDate = target.workDate;
    const isCheckIn = !existing || !existing.checkIn;

    // Ilova boshqa amalni kutgan (eski holat: terminal orqali allaqachon
    // kelgan, boshqa qurilmada belgilagan...) — ko'r-ko'rona bajarilmaydi.
    const serverAction = isCheckIn
      ? 'CHECK_IN'
      : !existing?.checkOut
        ? 'CHECK_OUT'
        : 'DONE';
    if (
      dto.expectedAction &&
      serverAction !== 'DONE' &&
      dto.expectedAction !== serverAction
    ) {
      throw new ConflictException(
        serverAction === 'CHECK_OUT'
          ? `Kelishingiz allaqachon qayd etilgan (${dayjs(existing!.checkIn!).tz(TZ).format('HH:mm')}). Holat yangilandi — endi ketishni belgilashingiz mumkin.`
          : 'Bugun hali kelish qayd etilmagan. Holat yangilandi — avval kelishni belgilang.',
      );
    }

    // XAVFSIZLIK (2026-09-23 audit): check-in uchun selfie MAJBURIY. Ilgari
    // fayl yuborilmasa yuz tekshiruvi butunlay o'tkazib yuborilardi (hatto
    // strict rejimda ham). Mobil ilova har doim selfie yuboradi.
    if (isCheckIn && !selfieBuffer?.length) {
      throw new BadRequestException(
        'Check-in uchun selfie kerak. Kamerani yoqib, suratga tushing va qaytadan yuboring.',
      );
    }

    // 4a. Yuz tekshiruvi (Qaror 4) — check-in'da har doim; check-out'da
    //     faqat shubhali holatda (checkoutNeedsFaceMatch, pastda).
    let faceCheck: FaceCheckOutcome = {
      verified: false,
      deferred: false,
      reason: null,
    };
    if (isCheckIn) {
      faceCheck = await this.verifyFaceOrThrow(
        userId,
        employee,
        selfieBuffer as Buffer,
        'CHECK_IN',
      );
    }

    // 5. Selfie saqlash (ish joyi isboti sifatida)
    // Faqat check-in'da: ilgari check-out'da ham shu nomga yozilib, kelish
    // selfisi ketish selfisi bilan almashib qolardi.
    let selfieUrl: string | undefined;
    if (isCheckIn && selfieBuffer?.length) {
      const uploadDir = path.join(
        process.env.UPLOAD_DIR || './uploads',
        'selfies',
      );
      // Tasodifiy qism: sana + ID oxiri bo'yicha fayl nomini topib bo'lmasin
      const base = `${dayjs(workDate).format('YYYY-MM-DD')}-${employee.id.slice(-8)}-${randomBytes(8).toString('hex')}`;
      const { filename } = await processAndSavePhoto(
        selfieBuffer,
        uploadDir,
        base,
      );
      selfieUrl = `/uploads/selfies/${filename}`;
    }

    // ── CHECK-IN ───────────────────────────────────────────────────────────────
    if (isCheckIn) {
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
        gpsVerified: !!geoMatch?.inside,
        faceVerified: faceCheck.verified,
        faceCheckPending: faceCheck.deferred,
        faceCheckReason: faceCheck.deferred ? faceCheck.reason : null,
        checkInWorkSiteId: geoMatch?.inside ? geoMatch.center.workSiteId : null,
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

      // GPS yuqorida tekshirildi. Yuz — faqat shubhali holatda (smena
      // davomida ish joyidan tashqarida ko'rilgan yoki kuzatuv uzilgan):
      // aks holda boshqa odam xodim telefonidan "ketish"ni bosib qo'yishi
      // mumkin bo'lardi.
      if (
        existing.checkIn &&
        (await this.checkoutNeedsFaceMatch(userId, existing.checkIn))
      ) {
        if (!selfieBuffer?.length) {
          throw new BadRequestException(
            "Ketishni tasdiqlash uchun yuz tekshiruvi kerak. Kamerani yoqib, qaytadan urinib ko'ring.",
          );
        }
        await this.verifyFaceOrThrow(
          userId,
          employee,
          selfieBuffer,
          'CHECK_OUT',
        );
      }

      const expectedEnd =
        existing.expectedCheckOut ??
        this.buildExpectedCheckOut(recordWorkDate, schedule, fallbackShift);
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
        const base = `checkout-${dayjs(recordWorkDate).tz(TZ).format('YYYY-MM-DD')}-${employee.id.slice(-8)}-${randomBytes(8).toString('hex')}`;
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
          checkOutSource: 'MOBILE',
          autoCheckOut: false,
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

  /**
   * Xodimning hozirgi smenasi uchun davomat yozuvi.
   *
   * Odatda — bugungi yozuv. Lekin tungi smenada (masalan 20:00–08:00) soat
   * 02:00 da bugungi yozuv yo'q: kechagi yozuv ochiq (kelgan, ketmagan) va
   * kutilgan ketish bugunga to'g'ri keladi. Ilgari bu holatda yangi CHECK-IN
   * yaratilardi va tungi smena hech qachon yopilmasdi.
   */
  private async findSelfTarget(
    employeeId: string,
    eventDate: Date,
  ): Promise<{ existing: any | null; workDate: Date; overnight: boolean }> {
    const workDate = DateUtil.startOfDay(eventDate);
    const today = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, workDate },
    });
    if (today?.checkIn) return { existing: today, workDate, overnight: false };

    const yesterday = DateUtil.startOfDay(
      dayjs(workDate).subtract(1, 'day').toDate(),
    );
    const open = await this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        workDate: yesterday,
        checkIn: { not: null },
        checkOut: null,
      },
    });
    const now = eventDate.getTime();
    if (
      open?.checkIn &&
      open.expectedCheckOut &&
      open.expectedCheckOut.getTime() > workDate.getTime() &&
      now - open.checkIn.getTime() < OVERNIGHT_OPEN_MAX_MS &&
      now - open.expectedCheckOut.getTime() < OVERNIGHT_AFTER_END_MS
    ) {
      return { existing: open, workDate: yesterday, overnight: true };
    }
    return { existing: today, workDate, overnight: false };
  }

  /**
   * Mobil check-in ekrani uchun hozirgi holat: qaysi amal kutilmoqda,
   * joriy yozuv va smena vaqtlari. Qarorni server qiladi (selfCheckIn bilan
   * bir xil qoida) — telefon vaqt zonasi yoki eskirgan kesh xato qildirmaydi.
   */
  async getSelfToday(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { employee: { select: { id: true, hospitalId: true } } },
    });
    if (!user?.employee) throw new NotFoundException('Xodim profili topilmadi');
    const employeeId = user.employee.id;

    const now = new Date();
    const tzNow = dayjs(now).tz(TZ);
    const todayDate = DateUtil.startOfDay(now);
    const { existing, workDate, overnight } = await this.findSelfTarget(
      employeeId,
      now,
    );
    const [todaySchedule, activeSchedule] = await Promise.all([
      this.prisma.schedule.findUnique({
        where: { employeeId_date: { employeeId, date: todayDate } },
        include: { shift: true },
      }),
      this.findTodaySchedule(employeeId, todayDate, tzNow),
    ]);
    const fallbackShift =
      !activeSchedule && !existing?.expectedCheckIn
        ? await this.findFallbackShift(user.employee.hospitalId, tzNow)
        : null;

    const action: 'CHECK_IN' | 'CHECK_OUT' | 'DONE' = !existing?.checkIn
      ? 'CHECK_IN'
      : !existing.checkOut
        ? 'CHECK_OUT'
        : 'DONE';
    const OFF = new Set([
      'DAY_OFF',
      'SICK',
      'VACATION',
      'HOLIDAY',
      'MATERNITY_LEAVE',
      'OTHER_ABSENCE',
    ]);
    const shift = activeSchedule?.shift ?? todaySchedule?.shift ?? null;
    const dayOff =
      action === 'CHECK_IN' &&
      !!todaySchedule &&
      OFF.has(String(todaySchedule.status));

    return {
      action,
      /** Bugun grafik bo'yicha dam olish/ta'til va hali kelmagan */
      dayOff,
      /** Mobil ilova sarlavhasi uchun: DAY_OFF, VACATION, SICK ... */
      dayOffStatus: dayOff ? String(todaySchedule!.status) : null,
      overnight,
      workDate,
      serverTime: now,
      record: existing
        ? {
            id: existing.id,
            workDate: existing.workDate,
            checkIn: existing.checkIn,
            checkOut: existing.checkOut,
            status: existing.status,
            lateMinutes: existing.lateMinutes,
            excusedLateMin: existing.excusedLateMin,
            earlyLeaveMin: existing.earlyLeaveMin,
            overtimeMinutes: existing.overtimeMinutes,
            netWorkMin: existing.netWorkMin,
            expectedCheckIn: existing.expectedCheckIn,
            expectedCheckOut: existing.expectedCheckOut,
            faceVerified: existing.faceVerified,
            faceCheckPending: existing.faceCheckPending,
            gpsVerified: existing.gpsVerified,
            checkInSource: existing.checkInSource,
            checkInWorkSiteId: existing.checkInWorkSiteId,
          }
        : null,
      schedule: todaySchedule
        ? {
            status: todaySchedule.status,
            shift: todaySchedule.shift
              ? {
                  name: todaySchedule.shift.name,
                  startTime: todaySchedule.shift.startTime,
                  endTime: todaySchedule.shift.endTime,
                  isOvernight: todaySchedule.shift.isOvernight,
                  graceMinutes: todaySchedule.shift.graceMinutes,
                }
              : null,
          }
        : null,
      expectedCheckIn:
        existing?.expectedCheckIn ??
        (activeSchedule || fallbackShift
          ? this.buildExpectedCheckIn(workDate, activeSchedule, fallbackShift)
          : null),
      expectedCheckOut:
        existing?.expectedCheckOut ??
        (activeSchedule || fallbackShift
          ? this.buildExpectedCheckOut(workDate, activeSchedule, fallbackShift)
          : null),
      shiftName: shift?.name ?? fallbackShift?.name ?? null,
      graceMinutes:
        shift?.graceMinutes ??
        fallbackShift?.graceMinutes ??
        LATE_GRACE_MINUTES,
    };
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

      // Smenadan 2 soatgacha erta kelish odatiy: 08:30 kelgan xodim uchun
      // 09:00 smena 08:00 smenadan ustun bo'lishi kerak. Aks holda u
      // noto'g'ri "kechikdi" bo'lib qoladi. 2 soatdan uzoq kelgusi smena esa
      // tanlanmaydi (masalan 02:00 hodisasi 20:00 tungi smenaga tegishli).
      let score: number;
      if (diff >= -120 && diff <= 0) {
        score = Math.abs(diff);
      } else if (diff > 0) {
        score = diff + 60;
      } else {
        score = Math.abs(diff) + 720;
      }

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

    // Weekly stat faqat davomat faktlarini jamlaydi. Intizomiy pul jarimasi
    // tushuntirish va buyruqsiz avtomatik hisoblanmaydi.
    const penaltyLateMin = 0;
    const deductionAmount = 0;

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
