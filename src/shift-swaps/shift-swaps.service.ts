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
import { NotificationType, Prisma, ShiftSwapStatus } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { TelegramService } from '../telegram/telegram.service';
import { esc, firstNameOf } from '../telegram/employee-messages';
import { PushService } from '../push/push.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateSwapDto } from './dto/create-swap.dto';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/** Almashish qancha oldinga rejalashtirilishi mumkin */
const WINDOW_DAYS = 31;
/** Bugungi smena bo'lsa — boshlanishiga kamida shuncha qolgan bo'lishi kerak */
const MIN_LEAD_MIN = 60;

/**
 * Xodim shu kuni "bo'sh"mi: grafik yo'q, dam olish yoki bayram. Ta'til,
 * kasallik, dekret, o'qish — bo'sh emas (bunday kunda o'rniga chiqa olmaydi).
 */
const isFree = (row?: { status: string } | null) =>
  !row || row.status === 'DAY_OFF' || row.status === 'HOLIDAY';

const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];
const dayLabel = (d: Date) => {
  const t = dayjs(d).tz(TZ);
  return `${t.date()}-${MONTHS[t.month()]}`;
};

const EMP_SELECT = {
  id: true,
  fullName: true,
  photoUrl: true,
  userId: true,
  departmentId: true,
  telegramChatId: true,
  telegramReminders: true,
  position: { select: { name: true } },
  department: { select: { name: true } },
} as const;

const SWAP_INCLUDE = {
  requester: { select: EMP_SELECT },
  target: { select: EMP_SELECT },
} as const;

type SwapWithPeople = Prisma.ShiftSwapRequestGetPayload<{
  include: typeof SWAP_INCLUDE;
}>;

@Injectable()
export class ShiftSwapsService implements OnModuleInit {
  private readonly logger = new Logger(ShiftSwapsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    @Optional() private readonly push?: PushService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit() {
    this.telegram.registerDecisionHandler?.('swap', (id, decision, sub) =>
      this.reviewFromTelegram(id, decision, sub),
    );
  }

  // ── Yordamchilar ─────────────────────────────────────────────────────────

  static dateOf(key: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key))
      throw new BadRequestException("Sana formati noto'g'ri");
    return dayjs.tz(key, TZ).startOf('day').toDate();
  }

  private async me(userId: string) {
    const e = await this.prisma.employee.findUnique({
      where: { userId },
      select: {
        ...EMP_SELECT,
        hospitalId: true,
        firedAt: true,
        hospital: { select: { schedulePlanningMode: true } },
      },
    });
    if (!e || e.firedAt)
      throw new ForbiddenException('Xodim profili topilmadi');
    if (e.hospital?.schedulePlanningMode === 'POST_COVERAGE') {
      throw new BadRequestException(
        "Bu muassasada almashish «Mening grafigim» (reja) bo'limi orqali qilinadi",
      );
    }
    return e;
  }

  private schedulesOf(employeeIds: string[], from: Date, to: Date) {
    return this.prisma.schedule.findMany({
      where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } },
      include: { shift: true },
    });
  }

  /** Sana almashish uchun hali "kelajakda"mi (bugun bo'lsa — smena boshlanmagan) */
  private assertUpcoming(date: Date, startTime?: string | null) {
    const today = DateUtil.startOfDay(new Date());
    if (date < today)
      throw new BadRequestException("O'tgan kunni almashtirib bo'lmaydi");
    if (startTime && date.getTime() === today.getTime()) {
      const start = DateUtil.buildDateTime(date, startTime);
      if (start.getTime() - Date.now() < MIN_LEAD_MIN * 60_000) {
        throw new BadRequestException(
          'Smena boshlanishiga 1 soatdan kam qoldi — rahbar bilan bevosita gaplashing',
        );
      }
    }
  }

  // ── Xodim ────────────────────────────────────────────────────────────────

  /**
   * Tanlangan kunim uchun almashish variantlari (o'z bo'limimdagi hamkasblar):
   *  - COVER: o'sha kuni ishlamaydigan hamkasblar;
   *  - SWAP: men dam oladigan, hamkasb ishlaydigan kunlar (hamkasb esa mening
   *    kunimda bo'sh) yoki o'sha kunning o'zida boshqa smenada ishlaydiganlar.
   */
  async candidates(userId: string, dateKey: string) {
    const me = await this.me(userId);
    const date = ShiftSwapsService.dateOf(dateKey);
    const mine = await this.prisma.schedule.findUnique({
      where: { employeeId_date: { employeeId: me.id, date } },
      include: { shift: true },
    });
    if (!mine || mine.status !== 'WORKING' || !mine.shift) {
      throw new BadRequestException('Bu kuni sizda ish smenasi yo‘q');
    }
    this.assertUpcoming(date, mine.shift.startTime);

    const colleagues = await this.prisma.employee.findMany({
      where: {
        hospitalId: me.hospitalId,
        departmentId: me.departmentId,
        firedAt: null,
        id: { not: me.id },
        userId: { not: null },
      },
      select: {
        id: true,
        fullName: true,
        photoUrl: true,
        position: { select: { name: true } },
      },
      orderBy: { fullName: 'asc' },
    });
    if (!colleagues.length)
      return { mine: this.dayDto(mine), cover: [], swap: [] };

    const today = DateUtil.startOfDay(new Date());
    const until = dayjs(today).add(WINDOW_DAYS, 'day').toDate();
    const rows = await this.schedulesOf(
      [me.id, ...colleagues.map((c) => c.id)],
      today,
      until,
    );
    const key = (id: string, d: Date) => `${id}|${d.getTime()}`;
    const byKey = new Map(rows.map((r) => [key(r.employeeId, r.date), r]));
    const free = (id: string, d: Date) => isFree(byKey.get(key(id, d)));

    const cover = colleagues.filter((c) => free(c.id, date));
    const swap = colleagues
      .map((c) => {
        const options = rows
          .filter(
            (r) => r.employeeId === c.id && r.status === 'WORKING' && r.shift,
          )
          .filter((r) =>
            r.date.getTime() === date.getTime()
              ? r.shiftId !== mine.shiftId // o'sha kuni boshqa smena
              : free(me.id, r.date) && free(c.id, date),
          )
          .filter((r) => r.date >= today)
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .slice(0, 8)
          .map((r) => this.dayDto(r));
        return { employee: c, options };
      })
      .filter((x) => x.options.length);

    return { mine: this.dayDto(mine), cover, swap };
  }

  private dayDto(r: {
    date: Date;
    shift: {
      id: string;
      name: string;
      startTime: string;
      endTime: string;
    } | null;
  }) {
    return {
      date: dayjs(r.date).tz(TZ).format('YYYY-MM-DD'),
      shift: r.shift
        ? {
            id: r.shift.id,
            name: r.shift.name,
            startTime: r.shift.startTime,
            endTime: r.shift.endTime,
          }
        : null,
    };
  }

  /** Mening kelajakdagi ish kunlarim (almashish uchun tanlash) */
  async myUpcoming(userId: string) {
    const me = await this.me(userId);
    const today = DateUtil.startOfDay(new Date());
    const until = dayjs(today).add(WINDOW_DAYS, 'day').toDate();
    const rows = await this.prisma.schedule.findMany({
      where: {
        employeeId: me.id,
        date: { gte: today, lte: until },
        status: 'WORKING',
        shiftId: { not: null },
      },
      include: { shift: true },
      orderBy: { date: 'asc' },
    });
    return rows.map((r) => this.dayDto(r));
  }

  async create(userId: string, dto: CreateSwapDto) {
    const me = await this.me(userId);
    const date = ShiftSwapsService.dateOf(dto.requesterDate);
    const targetDate =
      dto.type === 'SWAP'
        ? ShiftSwapsService.dateOf(dto.targetDate ?? dto.requesterDate)
        : null;

    const target = await this.prisma.employee.findFirst({
      where: {
        id: dto.targetId,
        hospitalId: me.hospitalId,
        departmentId: me.departmentId,
        firedAt: null,
      },
      select: { id: true },
    });
    if (!target || target.id === me.id)
      throw new BadRequestException(
        "Hamkasb topilmadi (faqat o'z bo'limingizdagi xodim)",
      );

    const check = await this.validatePlan(
      dto.type,
      me.id,
      date,
      target.id,
      targetDate,
    );

    const dup = await this.prisma.shiftSwapRequest.findFirst({
      where: {
        status: { in: ['REQUESTED', 'ACCEPTED'] },
        OR: [
          { requesterId: me.id, requesterDate: date },
          { targetId: me.id, targetDate: date },
          ...(targetDate
            ? [
                { requesterId: target.id, requesterDate: targetDate },
                { targetId: target.id, targetDate },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    if (dup)
      throw new ConflictException(
        "Bu kun uchun almashish so'rovi allaqachon bor",
      );

    const swap = await this.prisma.shiftSwapRequest.create({
      data: {
        hospitalId: me.hospitalId,
        type: dto.type,
        requesterId: me.id,
        targetId: target.id,
        requesterDate: date,
        requesterShiftId: check.mine.shiftId,
        targetDate,
        targetShiftId: check.theirs?.shiftId ?? null,
        reason: dto.reason?.trim() || null,
      },
      include: SWAP_INCLUDE,
    });
    void this.notifyTarget(swap).catch((e) =>
      this.logger.warn(`Swap notify failed: ${e?.message ?? e}`),
    );
    return swap;
  }

  /**
   * Reja hozir ham bajarilishi mumkinmi (so'rov paytida ham, tasdiqlashda ham
   * tekshiriladi — oradagi vaqtda grafik o'zgargan bo'lishi mumkin).
   */
  private async validatePlan(
    type: 'SWAP' | 'COVER',
    meId: string,
    date: Date,
    targetId: string,
    targetDate: Date | null,
  ) {
    const get = (employeeId: string, d: Date) =>
      this.prisma.schedule.findUnique({
        where: { employeeId_date: { employeeId, date: d } },
        include: { shift: true },
      });
    const mine = await get(meId, date);
    if (!mine || mine.status !== 'WORKING' || !mine.shift)
      throw new BadRequestException('Bu kuni sizda ish smenasi yo‘q');
    this.assertUpcoming(date, mine.shift.startTime);
    const targetOnMyDay = await get(targetId, date);

    if (type === 'COVER') {
      if (!isFree(targetOnMyDay))
        throw new BadRequestException(
          targetOnMyDay?.status === 'WORKING'
            ? 'Hamkasb bu kuni o‘zi ishlaydi'
            : 'Hamkasb bu kuni ta’tilda yoki band',
        );
      return { mine, theirs: null, targetOnMyDay, meOnTheirDay: null };
    }
    if (!targetDate)
      throw new BadRequestException('Almashish kuni tanlanmagan');
    const theirs = await get(targetId, targetDate);
    if (!theirs || theirs.status !== 'WORKING' || !theirs.shift)
      throw new BadRequestException('Hamkasbning bu kuni smenasi yo‘q');
    this.assertUpcoming(targetDate, theirs.shift.startTime);
    const sameDay = targetDate.getTime() === date.getTime();
    if (sameDay) {
      if (theirs.shiftId === mine.shiftId)
        throw new BadRequestException(
          'Ikkalangiz bir xil smenadasiz — almashishga hojat yo‘q',
        );
      return { mine, theirs, targetOnMyDay, meOnTheirDay: mine };
    }
    const meOnTheirDay = await get(meId, targetDate);
    if (!isFree(meOnTheirDay))
      throw new BadRequestException(
        meOnTheirDay?.status === 'WORKING'
          ? 'Siz hamkasbning kunida o‘zingiz ishlaysiz'
          : 'Hamkasbning kunida siz ta’tildasiz yoki bandsiz',
      );
    if (!isFree(targetOnMyDay))
      throw new BadRequestException(
        targetOnMyDay?.status === 'WORKING'
          ? 'Hamkasb sizning kuningizda o‘zi ishlaydi'
          : 'Hamkasb sizning kuningizda ta’tilda yoki band',
      );
    return { mine, theirs, targetOnMyDay, meOnTheirDay };
  }

  async my(userId: string) {
    const me = await this.prisma.employee.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!me) throw new ForbiddenException('Xodim profili topilmadi');
    const since = dayjs().subtract(60, 'day').toDate();
    const [outgoing, incoming] = await Promise.all([
      this.prisma.shiftSwapRequest.findMany({
        where: { requesterId: me.id, createdAt: { gte: since } },
        include: SWAP_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.shiftSwapRequest.findMany({
        where: {
          targetId: me.id,
          createdAt: { gte: since },
          status: { not: 'CANCELLED' },
        },
        include: SWAP_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const shifts = await this.shiftMap([...outgoing, ...incoming]);
    return {
      outgoing: outgoing.map((s) => this.dto(s, shifts)),
      incoming: incoming.map((s) => this.dto(s, shifts)),
    };
  }

  /** Hamkasb javobi (faqat nishon xodim, REQUESTED holatida) */
  async respond(userId: string, id: string, accept: boolean) {
    const me = await this.prisma.employee.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!me) throw new ForbiddenException('Xodim profili topilmadi');
    const r = await this.prisma.shiftSwapRequest.updateMany({
      where: { id, targetId: me.id, status: 'REQUESTED' },
      data: {
        status: accept ? 'ACCEPTED' : 'DECLINED',
        respondedAt: new Date(),
      },
    });
    if (!r.count)
      throw new BadRequestException(
        "So'rov topilmadi yoki allaqachon javob berilgan",
      );
    const swap = await this.prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id },
      include: SWAP_INCLUDE,
    });
    void (accept ? this.notifyAccepted(swap) : this.notifyDeclined(swap)).catch(
      () => {},
    );
    return { id, status: swap.status };
  }

  async cancel(userId: string, id: string) {
    const me = await this.prisma.employee.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!me) throw new ForbiddenException('Xodim profili topilmadi');
    const r = await this.prisma.shiftSwapRequest.updateMany({
      where: {
        id,
        requesterId: me.id,
        status: { in: ['REQUESTED', 'ACCEPTED'] },
      },
      data: { status: 'CANCELLED' },
    });
    if (!r.count)
      throw new BadRequestException("Bu so'rovni bekor qilib bo'lmaydi");
    return { cancelled: true };
  }

  // ── Rahbar ───────────────────────────────────────────────────────────────

  async list(hospitalId: string, status?: string) {
    if (!hospitalId) return [];
    const st = Object.values(ShiftSwapStatus).includes(
      status as ShiftSwapStatus,
    )
      ? (status as ShiftSwapStatus)
      : undefined;
    const rows = await this.prisma.shiftSwapRequest.findMany({
      where: {
        hospitalId,
        ...(st
          ? { status: st }
          : { createdAt: { gte: dayjs().subtract(30, 'day').toDate() } }),
      },
      include: SWAP_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const shifts = await this.shiftMap(rows);
    return rows.map((s) => this.dto(s, shifts));
  }

  async review(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    reviewer: { userId: string | null; hospitalId: string },
    note?: string,
  ) {
    const swap = await this.prisma.shiftSwapRequest.findFirst({
      where: { id, hospitalId: reviewer.hospitalId },
      include: SWAP_INCLUDE,
    });
    if (!swap) throw new NotFoundException("So'rov topilmadi");
    if (swap.status !== 'ACCEPTED') {
      throw new ConflictException(
        swap.status === 'REQUESTED'
          ? 'Hamkasb hali rozilik bermagan'
          : "So'rov allaqachon ko'rib chiqilgan",
      );
    }

    if (decision === 'REJECTED') {
      const r = await this.prisma.shiftSwapRequest.updateMany({
        where: { id, status: 'ACCEPTED' },
        data: {
          status: 'REJECTED',
          reviewedById: reviewer.userId,
          reviewedAt: new Date(),
          reviewNote: note?.trim() || null,
        },
      });
      if (!r.count)
        throw new ConflictException("So'rov allaqachon ko'rib chiqilgan");
      void this.notifyReviewed(swap, false, note).catch(() => {});
      return { id, status: 'REJECTED' };
    }

    // Grafik o'zgargan bo'lishi mumkin — qayta tekshiramiz, keyin atomik qo'llaymiz
    const plan = await this.validatePlan(
      swap.type,
      swap.requesterId,
      swap.requesterDate,
      swap.targetId,
      swap.targetDate,
    );
    if (
      plan.mine.shiftId !== swap.requesterShiftId ||
      (plan.theirs && plan.theirs.shiftId !== swap.targetShiftId)
    ) {
      throw new ConflictException(
        "So'rovdan keyin grafik o'zgargan — xodimlar yangi so'rov yuborishi kerak",
      );
    }
    const noteA = `Almashish: ${swap.target.fullName}`;
    const noteB = `Almashish: ${swap.requester.fullName}`;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.shiftSwapRequest.updateMany({
        where: { id, status: 'ACCEPTED' },
        data: {
          status: 'APPROVED',
          reviewedById: reviewer.userId,
          reviewedAt: new Date(),
          reviewNote: note?.trim() || null,
        },
      });
      if (!claimed.count)
        throw new ConflictException("So'rov allaqachon ko'rib chiqilgan");

      const setDay = (
        employeeId: string,
        date: Date,
        shiftId: string | null,
        n: string,
      ) =>
        tx.schedule.upsert({
          where: { employeeId_date: { employeeId, date } },
          update: shiftId
            ? { status: 'WORKING', shiftId, note: n }
            : { status: 'DAY_OFF', shiftId: null, note: n },
          create: shiftId
            ? { employeeId, date, status: 'WORKING', shiftId, note: n }
            : { employeeId, date, status: 'DAY_OFF', note: n },
        });

      if (swap.type === 'COVER') {
        await setDay(swap.requesterId, swap.requesterDate, null, noteA);
        await setDay(
          swap.targetId,
          swap.requesterDate,
          plan.mine.shiftId,
          noteB,
        );
        return;
      }
      const same = swap.targetDate!.getTime() === swap.requesterDate.getTime();
      if (same) {
        await setDay(
          swap.requesterId,
          swap.requesterDate,
          plan.theirs!.shiftId,
          noteA,
        );
        await setDay(
          swap.targetId,
          swap.requesterDate,
          plan.mine.shiftId,
          noteB,
        );
      } else {
        await setDay(
          swap.targetId,
          swap.requesterDate,
          plan.mine.shiftId,
          noteB,
        );
        await setDay(swap.requesterId, swap.requesterDate, null, noteA);
        await setDay(
          swap.requesterId,
          swap.targetDate!,
          plan.theirs!.shiftId,
          noteA,
        );
        await setDay(swap.targetId, swap.targetDate!, null, noteB);
      }
    });

    void this.notifyReviewed(swap, true, note).catch(() => {});
    return { id, status: 'APPROVED' };
  }

  async reviewFromTelegram(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    sub: { hospitalId: string | null; employeeId: string | null },
  ) {
    if (!sub.hospitalId) return "⛔ Ruxsat yo'q";
    const reviewer = sub.employeeId
      ? await this.prisma.employee.findUnique({
          where: { id: sub.employeeId },
          select: { userId: true },
        })
      : null;
    try {
      await this.review(id, decision, {
        userId: reviewer?.userId ?? null,
        hospitalId: sub.hospitalId,
      });
      return decision === 'APPROVED'
        ? '✅ Tasdiqlandi — grafik yangilandi'
        : '❌ Rad etildi';
    } catch (e: any) {
      return `ℹ️ ${e?.message ?? 'Bajarib bo‘lmadi'}`;
    }
  }

  // ── Ko'rinish ────────────────────────────────────────────────────────────

  private async shiftMap(
    rows: { requesterShiftId: string | null; targetShiftId: string | null }[],
  ) {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.requesterShiftId, r.targetShiftId])
          .filter(Boolean) as string[],
      ),
    ];
    if (!ids.length)
      return new Map<
        string,
        { name: string; startTime: string; endTime: string }
      >();
    const list = await this.prisma.shiftTemplate.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, startTime: true, endTime: true },
    });
    return new Map(list.map((s) => [s.id, s]));
  }

  private dto(
    s: SwapWithPeople,
    shifts: Map<string, { name: string; startTime: string; endTime: string }>,
  ) {
    const person = (e: SwapWithPeople['requester']) => ({
      id: e.id,
      fullName: e.fullName,
      photoUrl: e.photoUrl,
      position: e.position?.name ?? null,
      department: e.department?.name ?? null,
    });
    return {
      id: s.id,
      type: s.type,
      status: s.status,
      reason: s.reason,
      reviewNote: s.reviewNote,
      createdAt: s.createdAt,
      requester: person(s.requester),
      target: person(s.target),
      requesterDate: dayjs(s.requesterDate).tz(TZ).format('YYYY-MM-DD'),
      requesterShift: s.requesterShiftId
        ? (shifts.get(s.requesterShiftId) ?? null)
        : null,
      targetDate: s.targetDate
        ? dayjs(s.targetDate).tz(TZ).format('YYYY-MM-DD')
        : null,
      targetShift: s.targetShiftId
        ? (shifts.get(s.targetShiftId) ?? null)
        : null,
    };
  }

  private describe(s: SwapWithPeople) {
    return s.type === 'COVER'
      ? `${dayLabel(s.requesterDate)} kuni ${esc(s.requester.fullName)} o'rniga ${esc(s.target.fullName)} chiqadi`
      : s.targetDate && s.targetDate.getTime() !== s.requesterDate.getTime()
        ? `${esc(s.requester.fullName)}: ${dayLabel(s.requesterDate)} ⇄ ${dayLabel(s.targetDate)} :${esc(s.target.fullName)}`
        : `${dayLabel(s.requesterDate)} — smenalar almashadi: ${esc(s.requester.fullName)} ⇄ ${esc(s.target.fullName)}`;
  }

  private async personal(
    e: {
      telegramChatId: string | null;
      telegramReminders: boolean;
      userId: string | null;
    },
    title: string,
    body: string,
  ) {
    if (e.telegramChatId && e.telegramReminders)
      await this.telegram.sendPersonal?.(e.telegramChatId, body);
    if (e.userId && this.push) {
      const plain = body.replace(/<[^>]+>/g, '');
      await this.push.sendToUser(e.userId, {
        title,
        body: plain,
        url: '/dashboard/my-schedule',
        tag: 'swap',
      });
      await this.notifications
        ?.create({
          type: NotificationType.ALERT,
          title,
          message: plain,
          userId: e.userId,
          metadata: { kind: 'shift-swap' },
        })
        .catch(() => {});
    }
  }

  private notifyTarget(s: SwapWithPeople) {
    const who = esc(firstNameOf(s.requester.fullName) || s.requester.fullName);
    const body =
      `🔁 <b>${who}</b> siz bilan smena almashmoqchi:\n${this.describe(s)}` +
      (s.reason ? `\n📝 «${esc(s.reason)}»` : '') +
      "\n\nStaffPlusPRO ilovasida «So'rovlar» bo'limida qabul qiling yoki rad eting.";
    return this.personal(s.target, "Smena almashish so'rovi 🔁", body);
  }

  private async notifyAccepted(s: SwapWithPeople) {
    await this.personal(
      s.requester,
      'Hamkasb rozi bo‘ldi ✅',
      `✅ ${esc(s.target.fullName)} almashishga rozi bo'ldi. Endi rahbariyat tasdiqlashi kutilmoqda.`,
    );
    const text =
      `🔁 <b>Smena almashish so'rovi</b>\n\n${this.describe(s)}` +
      (s.requester.department?.name
        ? `\n🏢 ${esc(s.requester.department.name)}`
        : '') +
      (s.reason ? `\n📝 «${esc(s.reason)}»` : '') +
      '\n\nIkkala xodim rozi. Tasdiqlansa, grafik avtomatik yangilanadi.';
    await this.telegram.sendDecisionRequest?.(s.hospitalId, text, 'swap', s.id);
    if (this.push) {
      const ids = await this.push.sendToHospital(
        s.hospitalId,
        {
          title: 'Smena almashish so‘rovi 🔁',
          body: `${s.requester.fullName} ⇄ ${s.target.fullName}`,
          url: '/dashboard/shift-swaps',
          tag: `swap-${s.id}`,
        },
        ['DIRECTOR', 'ADMIN', 'SUPER_ADMIN'],
      );
      await this.notifications
        ?.createForUsers(ids, {
          type: NotificationType.ALERT,
          title: 'Smena almashish so‘rovi 🔁',
          message: `${s.requester.fullName} ⇄ ${s.target.fullName}`,
          metadata: {
            kind: 'shift-swap',
            swapId: s.id,
            hospitalId: s.hospitalId,
          },
        })
        .catch(() => {});
    }
  }

  private notifyDeclined(s: SwapWithPeople) {
    return this.personal(
      s.requester,
      'Almashish rad etildi',
      `❌ ${esc(s.target.fullName)} almashishni rad etdi.`,
    );
  }

  private async notifyReviewed(
    s: SwapWithPeople,
    approved: boolean,
    note?: string,
  ) {
    const body = approved
      ? `✅ Smena almashish tasdiqlandi:\n${this.describe(s)}\n\nGrafik yangilandi.`
      : `❌ Smena almashish rahbariyat tomonidan rad etildi.${note ? `\nIzoh: ${esc(note)}` : ''}`;
    const title = approved
      ? 'Almashish tasdiqlandi ✅'
      : 'Almashish rad etildi';
    await Promise.all([
      this.personal(s.requester, title, body),
      this.personal(s.target, title, body),
    ]);
  }
}
