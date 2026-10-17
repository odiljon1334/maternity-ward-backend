import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  EmployeeStatus,
  OpenShiftOfferResponse,
  OpenShiftStatus,
  Prisma,
  SchedulePlanningMode,
} from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { TelegramService } from '../telegram/telegram.service';
import { esc } from '../telegram/employee-messages';
import { SchedulePlanningService } from '../schedule-planning/schedule-planning.service';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/** Qancha kun oldinga bo'sh smena e'lon qilish mumkin */
const WINDOW_DAYS = 14;
/** Smenalar orasidagi dam shundan kam bo'lsa — ogohlantirish (bloklamaydi) */
const REST_WARNING_HOURS = 12;
/**
 * Smena boshlanishiga oz qolganda yoki boshlangandan keyin tasdiqlansa,
 * o'rinbosarga yo'l uchun shuncha vaqt beriladi — kechikish undan keyin.
 */
export const LATE_APPROVAL_TRAVEL_MINUTES = 60;

const STATUS_LABEL: Record<string, string> = {
  WORKING: 'o‘z smenasi bor',
  SICK: 'kasallik varaqasida',
  VACATION: 'mehnat ta’tilida',
  MATERNITY_LEAVE: 'tug‘ruq ta’tilida',
  TRAINING: 'malaka oshirishda',
  OTHER_ABSENCE: 'boshqa sabab bilan yo‘q',
};

type ShiftLike = { startTime: string; endTime: string; isOvernight: boolean };

export type OpenShiftCandidate = {
  employeeId: string;
  fullName: string;
  positionName: string | null;
  positionMatch: boolean;
  eligible: boolean;
  /** Nega taklif qilib bo'lmaydi (bo'lsa — eligible=false) */
  blockers: string[];
  /** Taklif qilish mumkin, lekin mudir bilishi kerak */
  warnings: string[];
  telegramLinked: boolean;
};

export interface CreateOpenShiftInput {
  departmentId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Post rejali muassasada e'tiborga olinmaydi — smena rejadan olinadi */
  shiftId?: string;
  absentEmployeeId?: string | null;
  note?: string | null;
  employeeIds: string[];
}

const DETAIL_INCLUDE = {
  department: { select: { id: true, name: true } },
  shift: {
    select: {
      id: true,
      name: true,
      startTime: true,
      endTime: true,
      isOvernight: true,
    },
  },
  absentEmployee: { select: { id: true, fullName: true } },
  claimedBy: { select: { id: true, fullName: true } },
  offers: {
    select: {
      employeeId: true,
      notifiedAt: true,
      response: true,
      respondedAt: true,
      employee: { select: { fullName: true } },
    },
  },
} satisfies Prisma.OpenShiftInclude;

/**
 * Bo'sh smena birjasi (Operativ markaz davomi).
 *
 * Oqim: mudir bo'sh smenani shu bo'limdagi bo'sh xodimlarga taklif qiladi →
 * birinchi "Olaman" degan xodim band qiladi (CLAIMED) → mudir tasdiqlaydi
 * (FILLED) va smena xodimning grafigiga yoziladi. Rad etilsa smena yana
 * ochiq bo'ladi, boshqalar olishi mumkin.
 *
 * Post rejali muassasada (tug'ruqxona) bo'sh smena kimningdir tasdiqlangan
 * post rejadagi smenasi: "kim o'rniga" majburiy, smena rejadan olinadi va
 * tasdiqlash tasdiqlangan "o'rnini bosish" (SUBSTITUTION) orqali yoziladi —
 * post reja hujjati o'zgarmaydi, Excel'dagi "O'zgarishlar" varag'ida ko'rinadi.
 */
@Injectable()
export class OpenShiftsService implements OnModuleInit {
  private readonly logger = new Logger(OpenShiftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly schedulePlanning: SchedulePlanningService,
  ) {}

  onModuleInit() {
    this.telegram.registerDecisionHandler?.('openshift', (id, decision, sub) =>
      this.reviewFromTelegram(id, decision, sub),
    );
    this.telegram.registerEmployeeActionHandler?.(
      'openshift',
      (id, verb, chatId) => this.respondFromTelegram(id, verb, chatId),
    );
  }

  // ── Yordamchilar ───────────────────────────────────────────────────────

  static dateOf(key: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key))
      throw new BadRequestException('Sana formati noto‘g‘ri');
    return dayjs.tz(key, TZ).startOf('day').toDate();
  }

  /** Smenaning aniq boshlanish va tugash vaqti (tungi smena ertasi kuni tugaydi). */
  static interval(date: Date, shift: ShiftLike) {
    const start = DateUtil.buildDateTime(date, shift.startTime);
    let end = DateUtil.buildDateTime(date, shift.endTime);
    if (shift.isOvernight || end.getTime() <= start.getTime()) {
      end = dayjs(end).add(1, 'day').toDate();
    }
    return { start, end };
  }

  /**
   * Tasdiqdan keyin o'rinbosar qachon kelishi kerak.
   *
   * Smena boshlanishigacha yo'l uchun vaqt yetarli bo'lsa — null (odatdagi
   * smena boshlanishi). Aks holda tasdiq + LATE_APPROVAL_TRAVEL_MINUTES,
   * lekin smena tugashidan keyin emas. Ilgari tasdiq soat 10:00 da bo'lsa,
   * 08:00 dagi smenaga kelgan o'rinbosar 2 soat "kechikdi" deb yozilardi.
   */
  static lateStartAt(
    date: Date,
    shift: ShiftLike,
    approvedAt: Date,
  ): Date | null {
    const { start, end } = OpenShiftsService.interval(date, shift);
    const arrival =
      approvedAt.getTime() + LATE_APPROVAL_TRAVEL_MINUTES * 60_000;
    if (arrival <= start.getTime()) return null;
    return new Date(Math.min(arrival, end.getTime()));
  }

  private describe(date: Date, shift: ShiftLike, departmentName: string) {
    return `${dayjs(date).tz(TZ).format('DD.MM.YYYY')}, ${shift.startTime}–${shift.endTime} · ${departmentName}`;
  }

  private requireShiftId(shiftId: string | null | undefined): string {
    if (!shiftId) throw new BadRequestException('Smenani tanlang');
    return shiftId;
  }

  /** Muassasa va uning grafik rejimi (post reja yoki oddiy grafik) */
  private async loadHospital(hospitalId: string) {
    if (!hospitalId) throw new BadRequestException('Muassasa tanlanmagan');
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { id: true, schedulePlanningMode: true },
    });
    if (!hospital) throw new NotFoundException('Muassasa topilmadi');
    return {
      ...hospital,
      postCoverage:
        hospital.schedulePlanningMode === SchedulePlanningMode.POST_COVERAGE,
    };
  }

  /**
   * Post rejali muassasa: kelmagan xodimning shu kungi tasdiqlangan post
   * rejadagi smenasi. Bo'sh smena aynan shu smena bo'ladi.
   */
  private async requirePostEntry(
    hospitalId: string,
    departmentId: string,
    absentEmployeeId: string | null | undefined,
    date: Date,
  ) {
    if (!absentEmployeeId) {
      throw new BadRequestException(
        'Post rejali muassasada bo‘sh smena kimning o‘rniga ekanini tanlang',
      );
    }
    const absent = await this.prisma.employee.findFirst({
      where: { id: absentEmployeeId, hospitalId },
      select: { departmentId: true },
    });
    if (!absent) throw new NotFoundException('Xodim topilmadi');
    if (absent.departmentId !== departmentId) {
      throw new BadRequestException(
        'O‘rniga chiqiladigan xodim tanlangan bo‘limda emas',
      );
    }
    const entry = await this.schedulePlanning.findApprovedWorkingEntry(
      hospitalId,
      absentEmployeeId,
      date,
    );
    if (!entry?.shiftId) {
      throw new BadRequestException(
        'Xodimning shu kun uchun tasdiqlangan post rejada ish smenasi yo‘q',
      );
    }
    const alreadyMoved = await this.prisma.scheduleChangeRequest.findFirst({
      where: {
        hospitalId,
        status: 'APPROVED',
        type: { in: ['SUBSTITUTION', 'SWAP'] },
        OR: [{ primaryEntryId: entry.id }, { counterpartEntryId: entry.id }],
      },
      select: { id: true },
    });
    if (alreadyMoved) {
      throw new BadRequestException(
        'Bu smena allaqachon boshqa xodimga o‘tkazilgan',
      );
    }
    return entry;
  }

  /** Sana: bugundan WINDOW_DAYS gacha; bugungi smena tugamagan bo'lishi kerak. */
  private assertOpenWindow(date: Date, shift: ShiftLike) {
    const today = DateUtil.startOfDay(new Date());
    if (date < today)
      throw new BadRequestException('O‘tgan kun uchun e’lon qilib bo‘lmaydi');
    if (date > dayjs(today).add(WINDOW_DAYS, 'day').toDate()) {
      throw new BadRequestException(
        `Bo‘sh smena ko‘pi bilan ${WINDOW_DAYS} kun oldinga e’lon qilinadi`,
      );
    }
    if (OpenShiftsService.interval(date, shift).end <= new Date()) {
      throw new BadRequestException('Bu smena allaqachon tugagan');
    }
  }

  /**
   * Bo'limdagi har bir xodim shu smenani ola oladimi.
   *
   * Bloklaydi: ta'til/kasallik, o'sha kuni o'z smenasi, kechagi yoki ertangi
   * smenasi bilan vaqt kesishishi. Ogohlantiradi: smenalar orasidagi dam
   * REST_WARNING_HOURS dan kam.
   */
  async evaluateCandidates(
    hospitalId: string,
    departmentId: string,
    date: Date,
    shift: ShiftLike,
    absentEmployeeId?: string | null,
    onlyEmployeeIds?: string[],
  ): Promise<OpenShiftCandidate[]> {
    const { start, end } = OpenShiftsService.interval(date, shift);
    const yesterday = dayjs(date).subtract(1, 'day').toDate();
    const tomorrow = dayjs(date).add(1, 'day').toDate();

    const [employees, absent] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          hospitalId,
          departmentId,
          firedAt: null,
          status: EmployeeStatus.ACTIVE,
          id: {
            ...(absentEmployeeId && { not: absentEmployeeId }),
            ...(onlyEmployeeIds && { in: onlyEmployeeIds }),
          },
        },
        select: {
          id: true,
          fullName: true,
          positionId: true,
          telegramChatId: true,
          position: { select: { name: true } },
          schedules: {
            where: { date: { gte: yesterday, lte: tomorrow } },
            select: {
              date: true,
              status: true,
              shift: {
                select: { startTime: true, endTime: true, isOvernight: true },
              },
            },
          },
          leaveRequests: {
            where: {
              status: 'APPROVED',
              startDate: { lte: date },
              endDate: { gte: date },
            },
            select: { id: true },
          },
        },
        orderBy: { fullName: 'asc' },
      }),
      absentEmployeeId
        ? this.prisma.employee.findFirst({
            where: { id: absentEmployeeId, hospitalId },
            select: { positionId: true },
          })
        : Promise.resolve(null),
    ]);

    const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;
    const result = employees.map((employee) => {
      const blockers: string[] = [];
      const warnings: string[] = [];
      if (employee.leaveRequests.length) blockers.push('Tasdiqlangan ta’tilda');

      for (const row of employee.schedules) {
        const sameDay = row.date.getTime() === date.getTime();
        if (sameDay && row.status !== 'DAY_OFF' && row.status !== 'HOLIDAY') {
          blockers.push(`Bu kuni ${STATUS_LABEL[row.status] ?? 'band'}`);
          continue;
        }
        if (sameDay || row.status !== 'WORKING' || !row.shift) continue;
        const other = OpenShiftsService.interval(row.date, row.shift);
        if (other.start < end && other.end > start) {
          blockers.push(
            row.date < date
              ? 'Kechagi smenasi hali tugamagan'
              : 'Ertangi smenasi bilan vaqti kesishadi',
          );
          continue;
        }
        const rest =
          row.date < date
            ? start.getTime() - other.end.getTime()
            : other.start.getTime() - end.getTime();
        if (rest < REST_WARNING_HOURS * 3_600_000) {
          warnings.push(
            row.date < date
              ? `Oldingi smenadan keyin ${hours(rest)} soat dam`
              : `Keyingi smenagacha ${hours(rest)} soat dam`,
          );
        }
      }

      return {
        employeeId: employee.id,
        fullName: employee.fullName,
        positionName: employee.position?.name ?? null,
        positionMatch:
          !!absent?.positionId && absent.positionId === employee.positionId,
        eligible: blockers.length === 0,
        blockers,
        warnings,
        telegramLinked: !!employee.telegramChatId,
      };
    });

    return result.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        Number(b.positionMatch) - Number(a.positionMatch) ||
        a.warnings.length - b.warnings.length ||
        a.fullName.localeCompare(b.fullName),
    );
  }

  private async loadShiftAndDepartment(
    hospitalId: string,
    departmentId: string,
    shiftId: string,
  ) {
    const [department, shift] = await Promise.all([
      this.prisma.department.findFirst({
        where: { id: departmentId, hospitalId },
        select: { id: true, name: true },
      }),
      this.prisma.shiftTemplate.findFirst({
        where: { id: shiftId, hospitalId },
        select: {
          id: true,
          name: true,
          startTime: true,
          endTime: true,
          isOvernight: true,
        },
      }),
    ]);
    if (!department) throw new NotFoundException('Bo‘lim topilmadi');
    if (!shift) throw new NotFoundException('Smena topilmadi');
    return { department, shift };
  }

  // ── Mudir ──────────────────────────────────────────────────────────────

  async preview(
    hospitalId: string,
    input: Omit<CreateOpenShiftInput, 'employeeIds' | 'note'>,
  ) {
    const hospital = await this.loadHospital(hospitalId);
    const date = OpenShiftsService.dateOf(input.date);
    const entry = hospital.postCoverage
      ? await this.requirePostEntry(
          hospitalId,
          input.departmentId,
          input.absentEmployeeId,
          date,
        )
      : null;
    const { department, shift } = await this.loadShiftAndDepartment(
      hospitalId,
      input.departmentId,
      this.requireShiftId(entry?.shiftId ?? input.shiftId),
    );
    this.assertOpenWindow(date, shift);
    const candidates = await this.evaluateCandidates(
      hospitalId,
      department.id,
      date,
      shift,
      input.absentEmployeeId,
    );
    return {
      department,
      shift,
      date: input.date,
      postCoverage: hospital.postCoverage,
      candidates,
    };
  }

  async create(
    hospitalId: string,
    userId: string | null,
    input: CreateOpenShiftInput,
  ) {
    const hospital = await this.loadHospital(hospitalId);
    const date = OpenShiftsService.dateOf(input.date);
    // Post rejali muassasada smena kelmagan xodimning rejadagi smenasi
    const entry = hospital.postCoverage
      ? await this.requirePostEntry(
          hospitalId,
          input.departmentId,
          input.absentEmployeeId,
          date,
        )
      : null;
    const { department, shift } = await this.loadShiftAndDepartment(
      hospitalId,
      input.departmentId,
      this.requireShiftId(entry?.shiftId ?? input.shiftId),
    );
    this.assertOpenWindow(date, shift);

    const employeeIds = [...new Set(input.employeeIds)];
    if (!employeeIds.length)
      throw new BadRequestException('Kamida bitta xodimni tanlang');

    if (input.absentEmployeeId) {
      const absent = await this.prisma.employee.findFirst({
        where: { id: input.absentEmployeeId, hospitalId },
        select: { id: true },
      });
      if (!absent) throw new NotFoundException('Xodim topilmadi');
    }

    const duplicate = await this.prisma.openShift.findFirst({
      where: {
        hospitalId,
        departmentId: department.id,
        date,
        shiftId: shift.id,
        absentEmployeeId: input.absentEmployeeId ?? null,
        status: { in: [OpenShiftStatus.OPEN, OpenShiftStatus.CLAIMED] },
      },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException('Bu smena allaqachon birjaga chiqarilgan');

    const candidates = await this.evaluateCandidates(
      hospitalId,
      department.id,
      date,
      shift,
      input.absentEmployeeId,
      employeeIds,
    );
    const eligible = new Set(
      candidates.filter((c) => c.eligible).map((c) => c.employeeId),
    );
    const rejected = candidates.filter((c) => !c.eligible);
    if (candidates.length !== employeeIds.length || rejected.length) {
      throw new BadRequestException(
        rejected.length
          ? `Bu xodimlar smenani ola olmaydi: ${rejected
              .map((c) => `${c.fullName} (${c.blockers.join(', ')})`)
              .join('; ')}`
          : 'Tanlangan xodimlar shu bo‘limda topilmadi',
      );
    }

    const created = await this.prisma.openShift.create({
      data: {
        hospitalId,
        departmentId: department.id,
        date,
        shiftId: shift.id,
        absentEmployeeId: input.absentEmployeeId ?? null,
        note: input.note?.trim() || null,
        createdById: userId,
        offers: {
          create: [...eligible].map((employeeId) => ({ employeeId })),
        },
      },
      include: DETAIL_INCLUDE,
    });

    void this.sendOffers(created.id).catch((e) =>
      this.logger.warn(`Bo'sh smena takliflari yuborilmadi: ${e?.message}`),
    );
    return created;
  }

  /** Taklifni har bir xodimning shaxsiy Telegramiga yuboradi. */
  private async sendOffers(openShiftId: string) {
    const openShift = await this.prisma.openShift.findUnique({
      where: { id: openShiftId },
      include: {
        department: { select: { name: true } },
        shift: true,
        offers: {
          select: {
            id: true,
            employee: { select: { telegramChatId: true } },
          },
        },
      },
    });
    if (!openShift) return;
    const text =
      `🆘 <b>Bo'sh smena taklifi</b>\n` +
      `${esc(this.describe(openShift.date, openShift.shift, openShift.department.name))}\n` +
      (openShift.note ? `📝 ${esc(openShift.note)}\n` : '') +
      `\nBirinchi rozi bo'lgan xodim band qiladi, rahbar tasdiqlagach grafikka yoziladi.`;

    for (const offer of openShift.offers) {
      const chatId = offer.employee.telegramChatId;
      if (!chatId) continue;
      const sent = await this.telegram.sendOpenShiftOffer?.(
        chatId,
        text,
        openShift.id,
      );
      if (sent) {
        await this.prisma.openShiftOffer.update({
          where: { id: offer.id },
          data: { notifiedAt: new Date() },
        });
      }
    }
  }

  async list(hospitalId: string, status?: string) {
    if (!hospitalId) throw new BadRequestException('Muassasa tanlanmagan');
    const since = dayjs(DateUtil.startOfDay(new Date()))
      .subtract(7, 'day')
      .toDate();
    const rows = await this.prisma.openShift.findMany({
      where: {
        hospitalId,
        date: { gte: since },
        ...(status &&
          (Object.values(OpenShiftStatus) as string[]).includes(status) && {
            status: status as OpenShiftStatus,
          }),
      },
      include: DETAIL_INCLUDE,
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      expired:
        (row.status === OpenShiftStatus.OPEN ||
          row.status === OpenShiftStatus.CLAIMED) &&
        OpenShiftsService.interval(row.date, row.shift).end.getTime() <= now,
    }));
  }

  async cancel(id: string, hospitalId: string) {
    const openShift = await this.prisma.openShift.findFirst({
      where: { id, hospitalId },
      include: {
        claimedBy: { select: { telegramChatId: true } },
        shift: true,
        department: { select: { name: true } },
      },
    });
    if (!openShift) throw new NotFoundException('Bo‘sh smena topilmadi');
    const result = await this.prisma.openShift.updateMany({
      where: {
        id,
        status: { in: [OpenShiftStatus.OPEN, OpenShiftStatus.CLAIMED] },
      },
      data: { status: OpenShiftStatus.CANCELLED },
    });
    if (!result.count)
      throw new ConflictException('Bo‘sh smena allaqachon yopilgan');
    const chatId = openShift.claimedBy?.telegramChatId;
    if (chatId) {
      void this.telegram
        .sendPersonal?.(
          chatId,
          `ℹ️ Bo'sh smena bekor qilindi:\n${esc(this.describe(openShift.date, openShift.shift, openShift.department.name))}`,
        )
        .catch(() => {});
    }
    return { id, status: OpenShiftStatus.CANCELLED };
  }

  async review(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    reviewer: { userId: string | null; hospitalId: string },
    note?: string,
  ) {
    const openShift = await this.prisma.openShift.findFirst({
      where: { id, hospitalId: reviewer.hospitalId },
      include: {
        shift: true,
        department: { select: { name: true } },
        absentEmployee: { select: { fullName: true } },
        claimedBy: {
          select: { id: true, fullName: true, telegramChatId: true },
        },
      },
    });
    if (!openShift) throw new NotFoundException('Bo‘sh smena topilmadi');
    if (openShift.status !== OpenShiftStatus.CLAIMED || !openShift.claimedBy) {
      throw new ConflictException(
        openShift.status === OpenShiftStatus.OPEN
          ? 'Hali hech kim bu smenani olmagan'
          : 'Bu smena allaqachon ko‘rib chiqilgan',
      );
    }
    const claimer = openShift.claimedBy;
    const what = this.describe(
      openShift.date,
      openShift.shift,
      openShift.department.name,
    );
    const reviewData = {
      reviewedById: reviewer.userId,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    };

    if (decision === 'REJECTED') {
      // Smena yana ochiq: boshqa xodimlar olishi mumkin, rad etilgan xodim
      // qayta ololmaydi.
      await this.prisma.$transaction(async (tx) => {
        const r = await tx.openShift.updateMany({
          where: {
            id,
            status: OpenShiftStatus.CLAIMED,
            claimedById: claimer.id,
          },
          data: {
            ...reviewData,
            status: OpenShiftStatus.OPEN,
            claimedById: null,
            claimedAt: null,
          },
        });
        if (!r.count)
          throw new ConflictException('Bu smena allaqachon ko‘rib chiqilgan');
        await tx.openShiftOffer.updateMany({
          where: { openShiftId: id, employeeId: claimer.id },
          data: {
            response: OpenShiftOfferResponse.DECLINED,
            respondedAt: new Date(),
          },
        });
      });
      if (claimer.telegramChatId) {
        void this.telegram
          .sendPersonal?.(
            claimer.telegramChatId,
            `❌ Rahbar bo'sh smenani sizga bermadi:\n${esc(what)}` +
              (note?.trim() ? `\n📝 ${esc(note.trim())}` : ''),
          )
          .catch(() => {});
      }
      return { id, status: OpenShiftStatus.OPEN };
    }

    this.assertOpenWindow(openShift.date, openShift.shift);
    const [check] = await this.evaluateCandidates(
      reviewer.hospitalId,
      openShift.departmentId,
      openShift.date,
      openShift.shift,
      openShift.absentEmployeeId,
      [claimer.id],
    );
    if (!check?.eligible) {
      throw new ConflictException(
        `${claimer.fullName} endi bu smenani ola olmaydi: ${check?.blockers.join(', ') || 'bo‘limda topilmadi'}`,
      );
    }

    const hospital = await this.loadHospital(reviewer.hospitalId);
    const postEntry = hospital.postCoverage
      ? await this.requirePostEntry(
          reviewer.hospitalId,
          openShift.departmentId,
          openShift.absentEmployeeId,
          openShift.date,
        )
      : null;
    const requestedById = openShift.createdById ?? reviewer.userId;
    if (postEntry && !requestedById) {
      throw new BadRequestException('Tasdiqlash uchun web panel orqali kiring');
    }

    const scheduleNote = openShift.absentEmployee
      ? `Bo'sh smena: ${openShift.absentEmployee.fullName} o'rniga`
      : "Bo'sh smena birjasi";
    const expectedStartAt = OpenShiftsService.lateStartAt(
      openShift.date,
      openShift.shift,
      reviewData.reviewedAt,
    );
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.openShift.updateMany({
        where: { id, status: OpenShiftStatus.CLAIMED, claimedById: claimer.id },
        data: { ...reviewData, status: OpenShiftStatus.FILLED },
      });
      if (!r.count)
        throw new ConflictException('Bu smena allaqachon ko‘rib chiqilgan');
      if (postEntry) {
        // Post reja: tasdiqlangan "o'rnini bosish" — grafik shu orqali yoziladi
        await this.schedulePlanning.substituteFromOpenShift(tx, {
          hospitalId: reviewer.hospitalId,
          entryId: postEntry.id,
          replacementEmployeeId: claimer.id,
          requestedById: requestedById!,
          approvedById: reviewer.userId,
          reason: `Bo'sh smena birjasi: ${claimer.fullName}${openShift.absentEmployee ? ` — ${openShift.absentEmployee.fullName} o'rniga` : ''}`,
        });
        await tx.schedule.updateMany({
          where: { employeeId: claimer.id, date: openShift.date },
          data: { expectedStartAt },
        });
        return;
      }
      await tx.schedule.upsert({
        where: {
          employeeId_date: { employeeId: claimer.id, date: openShift.date },
        },
        update: {
          status: 'WORKING',
          shiftId: openShift.shiftId,
          note: scheduleNote,
          expectedStartAt,
        },
        create: {
          employeeId: claimer.id,
          date: openShift.date,
          status: 'WORKING',
          shiftId: openShift.shiftId,
          note: scheduleNote,
          expectedStartAt,
        },
      });
    });

    if (claimer.telegramChatId) {
      void this.telegram
        .sendPersonal?.(
          claimer.telegramChatId,
          `✅ Bo'sh smena sizga berildi va grafigingizga yozildi:\n${esc(what)}` +
            (expectedStartAt
              ? `\n🕐 Smena boshlangan — soat ${dayjs(expectedStartAt).tz(TZ).format('HH:mm')} gacha yetib keling, kechikish shundan keyin hisoblanadi.`
              : ''),
        )
        .catch(() => {});
    }
    return { id, status: OpenShiftStatus.FILLED };
  }

  private async reviewFromTelegram(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    sub: { hospitalId: string | null },
  ): Promise<string> {
    if (!sub.hospitalId) return 'Ruxsat yo‘q';
    try {
      const result = await this.review(id, decision, {
        userId: null,
        hospitalId: sub.hospitalId,
      });
      return result.status === OpenShiftStatus.FILLED
        ? '✅ Tasdiqlandi — grafikka yozildi'
        : '❌ Rad etildi — smena yana ochiq';
    } catch (e: any) {
      return e?.message ?? 'Amal bajarilmadi';
    }
  }

  // ── Xodim ──────────────────────────────────────────────────────────────

  private async employeeOf(userId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { userId },
      select: { id: true, hospitalId: true, firedAt: true },
    });
    if (!employee || employee.firedAt)
      throw new ForbiddenException('Xodim profili topilmadi');
    return employee;
  }

  async myOffers(userId: string) {
    const employee = await this.employeeOf(userId);
    const today = DateUtil.startOfDay(new Date());
    const offers = await this.prisma.openShiftOffer.findMany({
      where: {
        employeeId: employee.id,
        openShift: {
          date: { gte: dayjs(today).subtract(1, 'day').toDate() },
          OR: [
            { status: OpenShiftStatus.OPEN },
            { status: OpenShiftStatus.CLAIMED, claimedById: employee.id },
          ],
        },
      },
      include: {
        openShift: {
          include: {
            department: { select: { name: true } },
            shift: {
              select: {
                name: true,
                startTime: true,
                endTime: true,
                isOvernight: true,
              },
            },
            absentEmployee: { select: { fullName: true } },
          },
        },
      },
      orderBy: { openShift: { date: 'asc' } },
    });
    const now = Date.now();
    return offers
      .filter(
        (offer) =>
          OpenShiftsService.interval(
            offer.openShift.date,
            offer.openShift.shift,
          ).end.getTime() > now,
      )
      .map((offer) => ({
        id: offer.openShift.id,
        date: offer.openShift.date,
        status: offer.openShift.status,
        claimedByMe: offer.openShift.claimedById === employee.id,
        myResponse: offer.response,
        note: offer.openShift.note,
        department: offer.openShift.department,
        shift: offer.openShift.shift,
        absentEmployee: offer.openShift.absentEmployee,
      }));
  }

  /** Xodim "Olaman" — birinchi bo'lib bosgan band qiladi (atomik). */
  async claim(employeeId: string, id: string) {
    const offer = await this.prisma.openShiftOffer.findUnique({
      where: { openShiftId_employeeId: { openShiftId: id, employeeId } },
      include: {
        openShift: {
          include: {
            shift: true,
            department: { select: { name: true } },
            absentEmployee: { select: { fullName: true } },
          },
        },
        employee: { select: { fullName: true } },
      },
    });
    if (!offer) throw new ForbiddenException('Bu taklif sizga yuborilmagan');
    if (offer.response === OpenShiftOfferResponse.DECLINED) {
      throw new ConflictException('Siz bu taklifni rad etgansiz');
    }
    const openShift = offer.openShift;
    if (openShift.status !== OpenShiftStatus.OPEN) {
      throw new ConflictException(
        openShift.claimedById === employeeId
          ? 'Siz bu smenani allaqachon olgansiz'
          : 'Bu smenani boshqa hamkasb oldi',
      );
    }
    this.assertOpenWindow(openShift.date, openShift.shift);
    const [check] = await this.evaluateCandidates(
      openShift.hospitalId,
      openShift.departmentId,
      openShift.date,
      openShift.shift,
      openShift.absentEmployeeId,
      [employeeId],
    );
    if (!check?.eligible) {
      throw new BadRequestException(
        `Bu smenani ola olmaysiz: ${check?.blockers.join(', ') || 'bo‘limda emassiz'}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const r = await tx.openShift.updateMany({
        where: { id, status: OpenShiftStatus.OPEN },
        data: {
          status: OpenShiftStatus.CLAIMED,
          claimedById: employeeId,
          claimedAt: new Date(),
        },
      });
      if (!r.count)
        throw new ConflictException('Bu smenani boshqa hamkasb oldi');
      await tx.openShiftOffer.update({
        where: { id: offer.id },
        data: {
          response: OpenShiftOfferResponse.ACCEPTED,
          respondedAt: new Date(),
        },
      });
    });

    const html =
      `🙋 <b>${esc(offer.employee.fullName)}</b> bo'sh smenani oldi:\n` +
      esc(
        this.describe(
          openShift.date,
          openShift.shift,
          openShift.department.name,
        ),
      ) +
      (openShift.absentEmployee
        ? `\n👤 ${esc(openShift.absentEmployee.fullName)} o'rniga`
        : '') +
      `\n\nTasdiqlansa smena xodimning grafigiga yoziladi.`;
    void this.telegram
      .sendDecisionRequest?.(openShift.hospitalId, html, 'openshift', id)
      .catch(() => {});
    return { id, status: OpenShiftStatus.CLAIMED };
  }

  async decline(employeeId: string, id: string) {
    const r = await this.prisma.openShiftOffer.updateMany({
      where: {
        openShiftId: id,
        employeeId,
        response: null,
        openShift: { status: OpenShiftStatus.OPEN },
      },
      data: {
        response: OpenShiftOfferResponse.DECLINED,
        respondedAt: new Date(),
      },
    });
    if (!r.count) throw new ConflictException('Taklif allaqachon yopilgan');
    return { id, declined: true };
  }

  async claimByUser(userId: string, id: string) {
    const employee = await this.employeeOf(userId);
    return this.claim(employee.id, id);
  }

  async declineByUser(userId: string, id: string) {
    const employee = await this.employeeOf(userId);
    return this.decline(employee.id, id);
  }

  /** Telegram tugmasi: chat shu taklif yuborilgan xodimniki bo'lishi shart. */
  private async respondFromTelegram(
    id: string,
    verb: 'take' | 'skip',
    chatId: string,
  ): Promise<string> {
    const offer = await this.prisma.openShiftOffer.findFirst({
      where: {
        openShiftId: id,
        employee: { telegramChatId: chatId, firedAt: null },
      },
      select: { employeeId: true },
    });
    if (!offer) return 'Bu taklif sizga yuborilmagan';
    try {
      if (verb === 'skip') {
        await this.decline(offer.employeeId, id);
        return 'Rad etdingiz';
      }
      await this.claim(offer.employeeId, id);
      return '✅ Siz oldingiz — rahbar tasdig‘i kutilmoqda';
    } catch (e: any) {
      return e?.message ?? 'Amal bajarilmadi';
    }
  }
}
