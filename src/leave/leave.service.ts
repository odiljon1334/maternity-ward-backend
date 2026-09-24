import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EmployeeStatus,
  LeaveStatus,
  LeaveType,
  ScheduleStatus,
} from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { PushService } from '../push/push.service';
import { CreateLeaveDto, ReviewLeaveDto } from './dto/leave.dto';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/**
 * Ta'til turi → grafik holati. Haqsiz ta'til ilgari VACATION bo'lib yozilib,
 * oylikda to'lanadigan ta'til kabi ko'rinardi; tug'ruq ta'tili ham.
 * Oylik baribir LeaveRequest turiga qaraydi (eski yozuvlar uchun ham).
 */
const LEAVE_TO_SCHEDULE: Record<LeaveType, ScheduleStatus> = {
  VACATION: ScheduleStatus.VACATION,
  SICK: ScheduleStatus.SICK,
  PERSONAL: ScheduleStatus.VACATION,
  MATERNITY: ScheduleStatus.MATERNITY_LEAVE,
  UNPAID: ScheduleStatus.OTHER_ABSENCE,
};

/** Ta'til yozadigan grafik holatlari (qaytarishda shular tiklanadi) */
const LEAVE_WRITTEN_STATUSES: ScheduleStatus[] = [
  ScheduleStatus.VACATION,
  ScheduleStatus.SICK,
  ScheduleStatus.MATERNITY_LEAVE,
  ScheduleStatus.OTHER_ABSENCE,
];

const LEAVE_NOTE_PREFIX = "Ta'til: ";

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  VACATION: "Yillik ta'til",
  SICK: 'Kasallik',
  PERSONAL: 'Shaxsiy sabab',
  MATERNITY: "Tug'ruq ta'tili",
  UNPAID: "Haqsiz ta'til",
};

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly push: PushService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // EMPLOYEE: so'rov yaratish
  // ─────────────────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateLeaveDto) {
    const employee = await this.getEmployeeByUserId(userId);

    const start = dayjs.tz(dto.startDate, TZ).startOf('day').toDate();
    const end = dayjs.tz(dto.endDate, TZ).startOf('day').toDate();

    if (dayjs(end).isBefore(dayjs(start))) {
      throw new BadRequestException(
        "Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas",
      );
    }

    const daysCount = dayjs(end).diff(dayjs(start), 'day') + 1;

    if (daysCount > 365) {
      throw new BadRequestException("Ta'til 365 kundan oshmasligi kerak");
    }

    const overlap = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId: employee.id,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: end },
        endDate: { gte: start },
      },
    });
    if (overlap) {
      throw new BadRequestException(
        `Bu muddat uchun allaqachon ${overlap.status === 'PENDING' ? "ko'rib chiqilayotgan" : 'tasdiqlangan'} so'rov mavjud`,
      );
    }

    const leave = await this.prisma.leaveRequest.create({
      data: {
        employeeId: employee.id,
        hospitalId: employee.hospitalId,
        type: dto.type,
        startDate: start,
        endDate: end,
        daysCount,
        reason: dto.reason,
        status: LeaveStatus.PENDING,
      },
      include: {
        employee: {
          include: { department: true, position: true, hospital: true },
        },
      },
    });

    this.telegram
      .notifyLeaveRequest(leave, 'CREATED')
      .catch((e) =>
        this.logger.warn(`Telegram leave notify failed: ${e.message}`),
      );

    this.push
      .notifyLeaveCreated(
        employee.hospitalId,
        employee.fullName,
        dto.type,
        leave.id,
      )
      .catch((e) =>
        this.logger.warn(`Push leave created failed: ${e?.message ?? e}`),
      );
    this.logger.log(
      `Leave created: ${employee.fullName} → ${LEAVE_TYPE_LABELS[dto.type]} ${dto.startDate}–${dto.endDate}`,
    );
    return leave;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EMPLOYEE: o'z so'rovlarini ko'rish
  // ─────────────────────────────────────────────────────────────────────────────

  async getMyLeaves(
    userId: string,
    params?: { status?: string; page?: number; limit?: number },
  ) {
    const employee = await this.getEmployeeByUserId(userId);
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { employeeId: employee.id };
    if (params?.status && params.status !== 'ALL') {
      where.status = params.status as LeaveStatus;
    }

    const [total, records] = await Promise.all([
      this.prisma.leaveRequest.count({ where }),
      this.prisma.leaveRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return { records, total, page, limit };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECTOR/ADMIN: barcha so'rovlarni ko'rish
  // ─────────────────────────────────────────────────────────────────────────────

  async getAll(
    hospitalId: string,
    params?: { status?: string; page?: number; limit?: number },
  ) {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 30;
    const skip = (page - 1) * limit;

    const where: any = { hospitalId };
    if (params?.status && params.status !== 'ALL') {
      where.status = params.status as LeaveStatus;
    }

    const [total, records] = await Promise.all([
      this.prisma.leaveRequest.count({ where }),
      this.prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { include: { department: true, position: true } },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    const pendingCount = await this.prisma.leaveRequest.count({
      where: { hospitalId, status: LeaveStatus.PENDING },
    });

    return { records, total, page, limit, pendingCount };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECTOR/ADMIN: so'rovni tasdiqlash / rad etish
  // ─────────────────────────────────────────────────────────────────────────────

  async review(
    leaveId: string,
    reviewerId: string,
    dto: ReviewLeaveDto,
    hospitalId: string,
  ) {
    const leave = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      include: {
        employee: {
          include: { department: true, position: true, hospital: true },
        },
      },
    });
    if (!leave) throw new NotFoundException("Ta'til so'rovi topilmadi");
    if (hospitalId && leave.hospitalId !== hospitalId)
      throw new ForbiddenException("Ruxsat yo'q");
    if (leave.status !== LeaveStatus.PENDING) {
      throw new BadRequestException(
        `So'rov allaqachon ${leave.status} holatida`,
      );
    }

    const newStatus =
      dto.decision === 'APPROVED' ? LeaveStatus.APPROVED : LeaveStatus.REJECTED;

    const updated = await this.prisma.leaveRequest.update({
      where: { id: leaveId },
      data: {
        status: newStatus,
        reviewedBy: reviewerId,
        reviewNote: dto.reviewNote,
        reviewedAt: new Date(),
      },
      include: {
        employee: {
          include: { department: true, position: true, hospital: true },
        },
      },
    });

    if (newStatus === LeaveStatus.APPROVED) {
      // Jadval kunlarini VACATION/SICK ga o'tkazish
      await this.applyLeaveToSchedule(updated);

      // Xodim statusini ON_LEAVE ga o'tkazish
      await this.prisma.employee.update({
        where: { id: leave.employeeId },
        data: { status: EmployeeStatus.ON_LEAVE },
      });

      this.logger.log(`Employee → ON_LEAVE: ${leave.employee.fullName}`);
    }

    this.telegram
      .notifyLeaveRequest(updated, dto.decision)
      .catch((e) =>
        this.logger.warn(`Telegram leave decision notify failed: ${e.message}`),
      );

    if (updated.employee.userId) {
      this.push
        .notifyLeaveReviewed(
          updated.employee.userId,
          dto.decision,
          updated.type,
          updated.id,
        )
        .catch((e) =>
          this.logger.warn(`Push leave reviewed failed: ${e?.message ?? e}`),
        );
    }

    this.logger.log(
      `Leave ${newStatus}: ${leave.employee.fullName} ` +
        `(${LEAVE_TYPE_LABELS[leave.type]} ${dayjs(leave.startDate).format('DD.MM')}–${dayjs(leave.endDate).format('DD.MM')}) ` +
        `by userId=${reviewerId}`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EMPLOYEE: o'z PENDING so'rovini bekor qilish
  // ─────────────────────────────────────────────────────────────────────────────

  async cancel(leaveId: string, userId: string) {
    const employee = await this.getEmployeeByUserId(userId);

    const leave = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
    });
    if (!leave) throw new NotFoundException("Ta'til so'rovi topilmadi");
    if (leave.employeeId !== employee.id)
      throw new ForbiddenException("Ruxsat yo'q");
    if (leave.status === LeaveStatus.APPROVED) {
      throw new BadRequestException(
        "Tasdiqlangan ta'tilni bekor qilish uchun direktorbga murojaat qiling",
      );
    }
    if (leave.status === LeaveStatus.CANCELLED) {
      throw new BadRequestException("So'rov allaqachon bekor qilingan");
    }

    return this.prisma.leaveRequest.update({
      where: { id: leaveId },
      data: { status: LeaveStatus.CANCELLED },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECTOR: tasdiqlangan ta'tilni qaytarish (APPROVED → CANCELLED)
  // ─────────────────────────────────────────────────────────────────────────────

  async revokeApproval(leaveId: string, hospitalId: string) {
    const leave = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      include: { employee: true },
    });
    if (!leave) throw new NotFoundException("Ta'til so'rovi topilmadi");
    if (hospitalId && leave.hospitalId !== hospitalId)
      throw new ForbiddenException("Ruxsat yo'q");
    if (leave.status !== LeaveStatus.APPROVED) {
      throw new BadRequestException("Faqat APPROVED so'rovni qaytarish mumkin");
    }

    // Jadval kunlarini WORKING ga qaytarish
    await this.revertScheduleFromLeave(leave);

    // Xodim statusini ACTIVE ga qaytarish
    await this.prisma.employee.update({
      where: { id: leave.employeeId },
      data: { status: EmployeeStatus.ACTIVE },
    });

    this.logger.log(`Employee → ACTIVE (revoked): ${leave.employee.fullName}`);

    return this.prisma.leaveRequest.update({
      where: { id: leaveId },
      data: {
        status: LeaveStatus.CANCELLED,
        reviewNote: 'Direktor tomonidan qaytarildi',
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CRON tomonidan chaqiriladi — muddati o'tgan ta'tillarni yakunlash
  // ─────────────────────────────────────────────────────────────────────────────

  async completeExpiredLeaves(): Promise<void> {
    const todayStart = dayjs().tz(TZ).startOf('day').toDate();

    const expired = await this.prisma.leaveRequest.findMany({
      where: {
        status: LeaveStatus.APPROVED,
        endDate: { lt: todayStart },
      },
      include: { employee: true },
    });

    if (!expired.length) return;

    for (const leave of expired) {
      // LeaveRequest → COMPLETED
      await this.prisma.leaveRequest.update({
        where: { id: leave.id },
        data: { status: LeaveStatus.COMPLETED },
      });

      // Xodim → ACTIVE (faqat ON_LEAVE bo'lsa)
      if (leave.employee.status === EmployeeStatus.ON_LEAVE) {
        await this.prisma.employee.update({
          where: { id: leave.employeeId },
          data: { status: EmployeeStatus.ACTIVE },
        });
        this.logger.log(`Ta'til tugadi → ACTIVE: ${leave.employee.fullName}`);
      }
    }

    this.logger.log(
      `completeExpiredLeaves: ${expired.length} ta ta'til yakunlandi`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE: ta'til tasdiqlanganda Schedule ni yangilash
  // ─────────────────────────────────────────────────────────────────────────────

  private async applyLeaveToSchedule(leave: any) {
    const scheduleStatus = LEAVE_TO_SCHEDULE[leave.type as LeaveType];
    const start = dayjs(leave.startDate).tz(TZ).startOf('day');
    const end = dayjs(leave.endDate).tz(TZ).startOf('day');

    const note = `${LEAVE_NOTE_PREFIX}${LEAVE_TYPE_LABELS[leave.type as LeaveType]}`;

    let cursor = start;
    let count = 0;

    while (cursor.isSame(end) || cursor.isBefore(end)) {
      const dateUTC = cursor.toDate();
      const where = {
        employeeId_date: { employeeId: leave.employeeId, date: dateUTC },
      };

      const existing = await this.prisma.schedule.findUnique({
        where,
        select: { id: true, status: true, note: true, preLeaveStatus: true },
      });
      if (existing) {
        // Oldingi holat saqlanadi (ta'til qaytarilganda tiklash uchun).
        // Kun allaqachon ta'til bo'lsa — birinchi ta'tildan oldingisi qoladi.
        const alreadyLeave =
          LEAVE_WRITTEN_STATUSES.includes(existing.status) &&
          (existing.note ?? '').startsWith(LEAVE_NOTE_PREFIX);
        await this.prisma.schedule.update({
          where: { id: existing.id },
          data: {
            status: scheduleStatus,
            note,
            preLeaveStatus: alreadyLeave
              ? existing.preLeaveStatus
              : existing.status,
          },
        });
      } else {
        await this.prisma.schedule.create({
          data: {
            employeeId: leave.employeeId,
            date: dateUTC,
            status: scheduleStatus,
            note,
            preLeaveStatus: null, // grafikda bu kun yo'q edi
          },
        });
      }

      cursor = cursor.add(1, 'day');
      count++;
    }

    this.logger.log(
      `Schedule updated: ${leave.employee?.fullName} — ${count} kun`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE: ta'til bekor qilinganda Schedule ni qaytarish
  // ─────────────────────────────────────────────────────────────────────────────

  private async revertScheduleFromLeave(leave: any) {
    const start = dayjs(leave.startDate).tz(TZ).startOf('day');
    const end = dayjs(leave.endDate).tz(TZ).startOf('day');

    let cursor = start;
    while (cursor.isSame(end) || cursor.isBefore(end)) {
      const dateUTC = cursor.toDate();

      const sch = await this.prisma.schedule.findUnique({
        where: {
          employeeId_date: { employeeId: leave.employeeId, date: dateUTC },
        },
      });

      // Faqat ta'til yozgan kunlar (qo'lda qo'yilgan kasallik/yo'qlik emas)
      if (
        sch &&
        LEAVE_WRITTEN_STATUSES.includes(sch.status) &&
        (sch.note ?? '').startsWith(LEAVE_NOTE_PREFIX)
      ) {
        if (sch.preLeaveStatus) {
          // Oldingi holat (ish kuni, dam olish kuni...) tiklanadi
          await this.prisma.schedule.update({
            where: { id: sch.id },
            data: { status: sch.preLeaveStatus, note: null, preLeaveStatus: null },
          });
        } else if (sch.shiftId) {
          // Eski yozuv (preLeaveStatus yo'q): grafik generatori faqat ish
          // kunlariga smena qo'yadi — smenasi bor kun ish kuni bo'lgan
          await this.prisma.schedule.update({
            where: { id: sch.id },
            data: { status: ScheduleStatus.WORKING, note: null },
          });
        } else {
          // Ta'til uchun yaratilgan (grafikda yo'q edi) — olib tashlanadi.
          // Ilgari bunday kunlar, dam olish kunlari ham, WORKING bo'lib
          // qolardi va xodim "kelmadi" deb belgilanardi.
          const removed = await this.prisma.schedule.deleteMany({
            where: { id: sch.id, attendance: { is: null } },
          });
          if (removed.count === 0) {
            // Davomat yozuvi bog'langan — o'chirmasdan dam olish kuni qilamiz
            await this.prisma.schedule.update({
              where: { id: sch.id },
              data: { status: ScheduleStatus.DAY_OFF, note: null },
            });
          }
        }
      }

      cursor = cursor.add(1, 'day');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE: userId dan employee olish
  // ─────────────────────────────────────────────────────────────────────────────

  private async getEmployeeByUserId(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { include: { hospital: true } } },
    });
    if (!user?.employee) {
      throw new NotFoundException(
        'Bu foydalanuvchi uchun xodim profili topilmadi',
      );
    }
    return user.employee;
  }
}
