import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { AttendanceNoticeStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { TelegramService } from '../telegram/telegram.service';
import { PushService } from '../push/push.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { applyNoticeExcuse } from './notice-excuse.util';

export const NOTICE_REASON_LABEL: Record<string, string> = {
  TRAFFIC: "Yo'l tirband",
  TRANSPORT: 'Transport (taksi, avtobus)',
  FAMILY: 'Oilaviy sabab',
  HEALTH: "Sog'liq",
  OTHER: 'Boshqa sabab',
};

const NOTICE_INCLUDE = {
  employee: {
    select: {
      id: true,
      fullName: true,
      photoUrl: true,
      userId: true,
      telegramChatId: true,
      telegramReminders: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  },
} as const;

type Reviewer = { userId: string | null; hospitalId: string };

@Injectable()
export class AttendanceNoticesService implements OnModuleInit {
  private readonly logger = new Logger(AttendanceNoticesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    @Optional() private readonly push?: PushService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Telegram'dagi "Tasdiqlash / Rad etish" tugmalari shu servisga yo'naltiriladi */
  onModuleInit() {
    this.telegram.registerDecisionHandler?.('notice', (id, decision, sub) =>
      this.reviewFromTelegram(id, decision, sub),
    );
  }

  private async employeeOf(userId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { userId },
      select: { id: true, hospitalId: true, fullName: true, firedAt: true },
    });
    if (!employee || employee.firedAt)
      throw new ForbiddenException('Xodim profili topilmadi');
    return employee;
  }

  // ── Xodim ────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateNoticeDto) {
    const employee = await this.employeeOf(userId);
    const workDate = DateUtil.startOfDay(new Date());

    const record = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId: employee.id, workDate },
      select: { checkOut: true },
    });
    if (record?.checkOut) {
      throw new BadRequestException('Bugungi ish kuni allaqachon yakunlangan');
    }

    const existing = await this.prisma.attendanceNotice.findFirst({
      where: {
        employeeId: employee.id,
        workDate,
        type: 'LATE_ARRIVAL',
        status: { in: ['PENDING', 'APPROVED'] },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'Bugun uchun kechikish xabari allaqachon yuborilgan',
      );
    }

    const notice = await this.prisma.attendanceNotice.create({
      data: {
        employeeId: employee.id,
        hospitalId: employee.hospitalId,
        reason: dto.reason,
        delayMinutes: dto.delayMinutes,
        comment: dto.comment?.trim() || null,
        workDate,
      },
      include: NOTICE_INCLUDE,
    });

    void this.notifyManagers(notice).catch((e) =>
      this.logger.warn(`Kechikish xabari yuborilmadi: ${e?.message ?? e}`),
    );
    return notice;
  }

  my(userId: string) {
    return this.prisma.user
      .findUnique({
        where: { id: userId },
        select: { employee: { select: { id: true } } },
      })
      .then((u) => {
        if (!u?.employee)
          throw new ForbiddenException('Xodim profili topilmadi');
        return this.prisma.attendanceNotice.findMany({
          where: { employeeId: u.employee.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
      });
  }

  async cancel(userId: string, id: string) {
    const employee = await this.employeeOf(userId);
    const r = await this.prisma.attendanceNotice.updateMany({
      where: { id, employeeId: employee.id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (!r.count)
      throw new BadRequestException(
        "Faqat ko'rib chiqilmagan xabarni bekor qilish mumkin",
      );
    return { cancelled: true };
  }

  // ── Rahbar ───────────────────────────────────────────────────────────────

  list(hospitalId: string, q: { status?: string; days?: number }) {
    if (!hospitalId) return [];
    const since = DateUtil.startOfDay(
      new Date(Date.now() - (q.days ?? 14) * 86_400_000),
    );
    const status = Object.values(AttendanceNoticeStatus).includes(
      q.status as AttendanceNoticeStatus,
    )
      ? (q.status as AttendanceNoticeStatus)
      : undefined;
    return this.prisma.attendanceNotice.findMany({
      where: {
        hospitalId,
        workDate: { gte: since },
        ...(status && { status }),
      },
      include: NOTICE_INCLUDE,
      orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async review(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    reviewer: Reviewer,
    note?: string,
  ) {
    const notice = await this.prisma.attendanceNotice.findFirst({
      where: { id, hospitalId: reviewer.hospitalId },
      include: NOTICE_INCLUDE,
    });
    if (!notice) throw new NotFoundException('Xabar topilmadi');

    // Faqat PENDING — ikki rahbar bir vaqtda bosganda birinchisi o'tadi
    const r = await this.prisma.attendanceNotice.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: decision,
        reviewedById: reviewer.userId,
        reviewedAt: new Date(),
        reviewNote: note?.trim() || null,
      },
    });
    if (!r.count) {
      throw new ConflictException(
        notice.status === 'CANCELLED'
          ? 'Xodim xabarni bekor qilgan'
          : "Xabar allaqachon ko'rib chiqilgan",
      );
    }

    let excused: number | null = null;
    if (decision === 'APPROVED') {
      excused = await applyNoticeExcuse(
        this.prisma,
        notice.employeeId,
        notice.workDate,
      );
    }
    void this.notifyEmployee(notice, decision, note).catch(() => {});
    return { id, status: decision, excusedLateMin: excused };
  }

  /** Telegram tugmasidan: rahbar obunasi shu muassasaniki bo'lishi shart */
  async reviewFromTelegram(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    sub: { hospitalId: string | null; employeeId: string | null },
  ): Promise<string> {
    if (!sub.hospitalId) return "⛔ Ruxsat yo'q";
    const reviewerUser = sub.employeeId
      ? await this.prisma.employee.findUnique({
          where: { id: sub.employeeId },
          select: { userId: true },
        })
      : null;
    try {
      await this.review(id, decision, {
        userId: reviewerUser?.userId ?? null,
        hospitalId: sub.hospitalId,
      });
      return decision === 'APPROVED'
        ? '✅ Tasdiqlandi — kechikish uzrli'
        : '❌ Rad etildi';
    } catch (e: any) {
      return `ℹ️ ${e?.message ?? 'Bajarib bo‘lmadi'}`;
    }
  }

  // ── Xabarnomalar ─────────────────────────────────────────────────────────

  private async shiftStart(employeeId: string, workDate: Date) {
    const sch = await this.prisma.schedule.findFirst({
      where: { employeeId, date: workDate },
      select: { shift: { select: { startTime: true } } },
    });
    return sch?.shift?.startTime ?? null;
  }

  private async notifyManagers(notice: any) {
    const start = await this.shiftStart(notice.employeeId, notice.workDate);
    const reason = NOTICE_REASON_LABEL[notice.reason] ?? notice.reason;
    const title = 'Kechikish haqida xabar 🕒';
    const body = `${notice.employee.fullName} — taxminan ${notice.delayMinutes} daqiqa kechikadi (${reason})`;

    await this.telegram.notifyAttendanceNotice?.({
      id: notice.id,
      hospitalId: notice.hospitalId,
      employeeName: notice.employee.fullName,
      position: notice.employee.position?.name ?? null,
      department: notice.employee.department?.name ?? null,
      delayMinutes: notice.delayMinutes,
      reason,
      comment: notice.comment,
      shiftStart: start,
    });

    if (this.push) {
      const ids = await this.push.sendToHospital(
        notice.hospitalId,
        {
          title,
          body,
          url: '/dashboard/attendance-notices',
          tag: `notice-${notice.id}`,
        },
        ['DIRECTOR', 'ADMIN', 'SUPER_ADMIN'],
      );
      await this.notifications
        ?.createForUsers(ids, {
          type: NotificationType.ALERT,
          title,
          message: body,
          metadata: {
            kind: 'attendance-notice',
            noticeId: notice.id,
            hospitalId: notice.hospitalId,
          },
        })
        .catch(() => {});
    }
  }

  private async notifyEmployee(
    notice: any,
    decision: 'APPROVED' | 'REJECTED',
    note?: string,
  ) {
    const approved = decision === 'APPROVED';
    const title = approved
      ? 'Kechikish uzrli deb topildi ✅'
      : 'Kechikish xabari rad etildi';
    const body = approved
      ? 'Rahbariyat xabaringizni tasdiqladi — bugungi kechikish uzrli hisoblanadi.'
      : `Rahbariyat xabaringizni rad etdi.${note ? ` Izoh: ${note}` : ''}`;

    if (
      notice.employee.telegramChatId &&
      notice.employee.telegramReminders !== false
    ) {
      await this.telegram.sendPersonal?.(
        notice.employee.telegramChatId,
        `${approved ? '✅' : '❌'} ${body}`,
      );
    }
    if (notice.employee.userId && this.push) {
      await this.push.sendToUser(notice.employee.userId, {
        title,
        body,
        url: '/dashboard',
        tag: `notice-${notice.id}`,
      });
      await this.notifications
        ?.create({
          type: NotificationType.ALERT,
          title,
          message: body,
          userId: notice.employee.userId,
          metadata: {
            kind: 'attendance-notice-reviewed',
            noticeId: notice.id,
            decision,
          },
        })
        .catch(() => {});
    }
  }
}
