import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  MonthlySchedulePlanStatus,
  NotificationType,
  Prisma,
  ScheduleChangeStatus,
  ScheduleChangeType,
  SchedulePlanEntryType,
  SchedulePlanningMode,
  SchedulePostCoverageMode,
  ScheduleStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSchedulePostDto } from './dto/create-schedule-post.dto';
import { UpdateSchedulePostDto } from './dto/update-schedule-post.dto';
import { CreateMonthlySchedulePlanDto } from './dto/create-monthly-schedule-plan.dto';
import { SaveSchedulePlanEntriesDto } from './dto/save-schedule-plan-entries.dto';
import { CreateScheduleChangeDto } from './dto/create-schedule-change.dto';
import {
  assertNoEmployeeOverlaps,
  calculateEmployeeShiftStats,
  calculateMonthlyCoverageTargets,
  calculateCoverageSummary,
  calculatePostNormBreakdown,
  normalizePostCoveragePolicy,
  PostCoveragePolicy,
  splitIntervalByCalendarDate,
} from './schedule-planning-calculator';
import { localDateParts } from './schedule-planning-time';
import { DateUtil } from '../common/utils/date.util';
import { NotificationsService } from '../notifications/notifications.service';
import {
  isLeaveWrittenSchedule,
  LEAVE_NOTE_PREFIX,
  LEAVE_WRITTEN_STATUSES,
} from '../leave/leave.service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import * as ExcelJS from 'exceljs';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';
const CHANGE_REQUEST_WINDOW_DAYS = 31;

/**
 * Grafik javobidagi xodim ma'lumoti — faqat jadval uchun kerakli maydonlar.
 * To'liq Employee (maosh, telefon, GPS, Telegram...) har katakda takrorlanib
 * javobning ~60% ini egallardi va keraksiz shaxsiy ma'lumotni ochardi.
 */
const PLAN_EMPLOYEE_SELECT = {
  id: true,
  fullName: true,
  userId: true,
  departmentId: true,
  positionId: true,
  position: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

/** Kunduzgi/kechki hisob va jadval uchun smenadan kerakli maydonlar. */
const PLAN_SHIFT_SELECT = {
  id: true,
  name: true,
  type: true,
  startTime: true,
  endTime: true,
  isOvernight: true,
} satisfies Prisma.ShiftTemplateSelect;

const PLAN_CHANGE_EMPLOYEE_SELECT = {
  id: true,
  fullName: true,
  userId: true,
  departmentId: true,
} satisfies Prisma.EmployeeSelect;

type PlanEntryWithWorkDate = {
  employeeId: string;
  entryType: SchedulePlanEntryType;
  startsAt: Date | null;
  endsAt: Date | null;
  workDate: Date;
  [key: string]: any;
};

export function calculateMonthlyCoverageMinutes(
  year: number,
  month: number,
  dailyCoverageMinutes: number,
  coverageMode: SchedulePostCoverageMode = SchedulePostCoverageMode.CONTINUOUS_24_7,
  coverageMinutesByWeekday?: unknown,
): number {
  const policy = normalizePostCoveragePolicy({
    coverageMode,
    dailyCoverageMinutes,
    coverageMinutesByWeekday,
  });
  return calculateMonthlyCoverageTargets(year, month, policy).targetMinutes;
}

@Injectable()
export class SchedulePlanningService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private assertChangeDateInWindow(date: Date) {
    const today = dayjs().tz(TZ).startOf('day');
    const value = dayjs(date).tz(TZ).startOf('day');
    if (value.isBefore(today)) {
      throw new BadRequestException(
        'O‘tib ketgan smenani o‘zgartirib bo‘lmaydi',
      );
    }
    if (value.isAfter(today.add(CHANGE_REQUEST_WINDOW_DAYS, 'day'))) {
      throw new BadRequestException(
        `Smena o‘zgarishi ko‘pi bilan ${CHANGE_REQUEST_WINDOW_DAYS} kun oldinga rejalashtiriladi`,
      );
    }
  }

  async getConfig(hospitalId: string) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { id: true, name: true, schedulePlanningMode: true },
    });
    if (!hospital) throw new NotFoundException('Muassasa topilmadi');
    return {
      ...hospital,
      postCoverageEnabled:
        hospital.schedulePlanningMode === SchedulePlanningMode.POST_COVERAGE,
    };
  }

  async listPosts(
    hospitalId: string,
    departmentId?: string,
    includeArchived = false,
  ) {
    await this.requirePostCoverage(hospitalId);
    return this.prisma.schedulePost.findMany({
      where: {
        hospitalId,
        ...(departmentId && { departmentId }),
        ...(!includeArchived && { isActive: true }),
      },
      include: { department: true },
      orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  async setPostStatus(hospitalId: string, postId: string, isActive: boolean) {
    await this.requirePostCoverage(hospitalId);
    const post = await this.prisma.schedulePost.findFirst({
      where: { id: postId, hospitalId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post topilmadi');

    return this.prisma.schedulePost.update({
      where: { id: post.id },
      data: { isActive },
      include: { department: true },
    });
  }

  async removePost(hospitalId: string, postId: string) {
    await this.requirePostCoverage(hospitalId);
    const post = await this.prisma.schedulePost.findFirst({
      where: { id: postId, hospitalId },
      select: { id: true, _count: { select: { plans: true } } },
    });
    if (!post) throw new NotFoundException('Post topilmadi');
    if (post._count.plans > 0) {
      throw new BadRequestException(
        'Bu postda grafik tarixi mavjud. Uni o‘chirish o‘rniga arxivlang.',
      );
    }

    await this.prisma.schedulePost.delete({ where: { id: post.id } });
    return { deleted: true };
  }

  async createPost(hospitalId: string, dto: CreateSchedulePostDto) {
    await this.requirePostCoverage(hospitalId);

    const department = await this.prisma.department.findFirst({
      where: { id: dto.departmentId, hospitalId },
      select: { id: true },
    });
    if (!department) {
      throw new BadRequestException(
        'Bo‘lim tanlangan muassasaga tegishli emas yoki topilmadi',
      );
    }

    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.schedulePost.findUnique({
      where: { hospitalId_code: { hospitalId, code } },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Bu post kodi allaqachon mavjud');

    const coverage = normalizePostCoveragePolicy(dto);
    return this.prisma.schedulePost.create({
      data: {
        hospitalId,
        departmentId: dto.departmentId,
        name: dto.name.trim(),
        code,
        coverageMode: coverage.coverageMode,
        dailyCoverageMinutes: coverage.dailyCoverageMinutes,
        coverageMinutesByWeekday:
          coverage.coverageMinutesByWeekday ?? Prisma.JsonNull,
      },
      include: { department: true },
    });
  }

  async updatePost(
    hospitalId: string,
    postId: string,
    dto: UpdateSchedulePostDto,
  ) {
    await this.requirePostCoverage(hospitalId);
    const post = await this.prisma.schedulePost.findFirst({
      where: { id: postId, hospitalId },
    });
    if (!post) throw new NotFoundException('Post topilmadi');

    const code = dto.code?.trim().toUpperCase() ?? post.code;
    const duplicate = await this.prisma.schedulePost.findFirst({
      where: { hospitalId, code, id: { not: post.id } },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException('Bu post kodi allaqachon mavjud');

    const coverage = normalizePostCoveragePolicy({
      coverageMode: dto.coverageMode ?? post.coverageMode,
      dailyCoverageMinutes:
        dto.dailyCoverageMinutes ?? post.dailyCoverageMinutes,
      coverageMinutesByWeekday:
        dto.coverageMinutesByWeekday ?? post.coverageMinutesByWeekday,
    });
    const coverageJson = coverage.coverageMinutesByWeekday ?? Prisma.JsonNull;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.schedulePost.update({
        where: { id: post.id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          code,
          coverageMode: coverage.coverageMode,
          dailyCoverageMinutes: coverage.dailyCoverageMinutes,
          coverageMinutesByWeekday: coverageJson,
        },
        include: { department: true },
      });

      // Qoralama hali tasdiqlanmagan: yangi qoida shu rejalarga qo'llanadi.
      // SUBMITTED/APPROVED rejalar esa audit uchun o'z snapshotida qoladi.
      await tx.monthlySchedulePlan.updateMany({
        where: {
          postId: post.id,
          hospitalId,
          status: MonthlySchedulePlanStatus.DRAFT,
        },
        data: {
          coverageMode: coverage.coverageMode,
          dailyCoverageMinutes: coverage.dailyCoverageMinutes,
          coverageMinutesByWeekday: coverageJson,
        },
      });
      return updated;
    });
  }

  async listPlans(
    hospitalId: string,
    filters: { year?: number; month?: number; postId?: string },
  ) {
    await this.requirePostCoverage(hospitalId);
    return this.prisma.monthlySchedulePlan.findMany({
      where: {
        hospitalId,
        ...(filters.year && { year: filters.year }),
        ...(filters.month && { month: filters.month }),
        ...(filters.postId && { postId: filters.postId }),
      },
      include: {
        post: { include: { department: true } },
        _count: { select: { entries: true, changeRequests: true } },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { version: 'desc' }],
    });
  }

  async createDraftPlan(
    hospitalId: string,
    createdById: string,
    dto: CreateMonthlySchedulePlanDto,
  ) {
    await this.requirePostCoverage(hospitalId);

    const post = await this.prisma.schedulePost.findFirst({
      where: { id: dto.postId, hospitalId, isActive: true },
      select: {
        id: true,
        coverageMode: true,
        dailyCoverageMinutes: true,
        coverageMinutesByWeekday: true,
      },
    });
    if (!post) {
      throw new BadRequestException(
        'Faol post tanlangan muassasaga tegishli emas yoki topilmadi',
      );
    }

    const unfinished = await this.prisma.monthlySchedulePlan.findFirst({
      where: {
        hospitalId,
        postId: post.id,
        year: dto.year,
        month: dto.month,
        status: {
          in: [
            MonthlySchedulePlanStatus.DRAFT,
            MonthlySchedulePlanStatus.SUBMITTED,
          ],
        },
      },
      select: { id: true, status: true },
    });
    if (unfinished) {
      throw new ConflictException(
        'Bu post va oy uchun yakunlanmagan reja allaqachon mavjud',
      );
    }

    const approved = await this.prisma.monthlySchedulePlan.findFirst({
      where: {
        hospitalId,
        postId: post.id,
        year: dto.year,
        month: dto.month,
        status: MonthlySchedulePlanStatus.APPROVED,
      },
      select: { id: true },
    });
    if (approved) {
      throw new ConflictException(
        'Tasdiqlangan grafik mavjud. O‘zgarish uchun smena almashtirish yoki o‘rnini bosish so‘rovidan foydalaning',
      );
    }

    const latest = await this.prisma.monthlySchedulePlan.findFirst({
      where: {
        hospitalId,
        postId: post.id,
        year: dto.year,
        month: dto.month,
      },
      select: { version: true },
      orderBy: { version: 'desc' },
    });

    const plan = await this.prisma.monthlySchedulePlan.create({
      data: {
        hospitalId,
        postId: post.id,
        year: dto.year,
        month: dto.month,
        version: (latest?.version ?? 0) + 1,
        createdById,
        coverageMode: post.coverageMode,
        dailyCoverageMinutes: post.dailyCoverageMinutes,
        coverageMinutesByWeekday:
          post.coverageMinutesByWeekday ?? Prisma.JsonNull,
      },
      include: { post: { include: { department: true } } },
    });

    const targetMinutes = calculateMonthlyCoverageMinutes(
      dto.year,
      dto.month,
      post.dailyCoverageMinutes,
      post.coverageMode,
      post.coverageMinutesByWeekday,
    );
    return {
      ...plan,
      targetCoverageMinutes: targetMinutes,
      targetCoverageHours: targetMinutes / 60,
    };
  }

  async getPlanDetails(hospitalId: string, planId: string) {
    await this.requirePostCoverage(hospitalId);
    const plan = await this.prisma.monthlySchedulePlan.findFirst({
      where: { id: planId, hospitalId },
      include: {
        hospital: { select: { id: true, name: true } },
        post: { include: { department: true } },
        createdBy: { select: { id: true, username: true } },
        approvedBy: { select: { id: true, username: true } },
        entries: {
          include: {
            employee: { select: PLAN_EMPLOYEE_SELECT },
            shift: { select: PLAN_SHIFT_SELECT },
          },
          orderBy: [{ employee: { fullName: 'asc' } }, { workDate: 'asc' }],
        },
        changeRequests: {
          include: {
            primaryEntry: {
              include: {
                employee: { select: PLAN_CHANGE_EMPLOYEE_SELECT },
                shift: true,
              },
            },
            counterpartEntry: {
              include: {
                employee: { select: PLAN_CHANGE_EMPLOYEE_SELECT },
                shift: true,
              },
            },
            replacementEmployee: { select: PLAN_CHANGE_EMPLOYEE_SELECT },
            requestedBy: { select: { id: true, username: true } },
            acceptedBy: { select: { id: true, username: true } },
            approvedBy: { select: { id: true, username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!plan) throw new NotFoundException('Oylik grafik topilmadi');

    const entries = await this.withCanonicalCarryIn(
      hospitalId,
      plan.postId,
      plan.year,
      plan.month,
      plan.entries,
    );
    const entriesWithMinutes = entries.map((entry) => ({
      ...entry,
      calendarMinutes:
        entry.entryType === SchedulePlanEntryType.WORKING &&
        entry.startsAt &&
        entry.endsAt
          ? splitIntervalByCalendarDate(
              entry.startsAt,
              entry.endsAt,
              plan.year,
              plan.month,
            )
          : {},
    }));
    const summary = this.buildPlanSummary({
      ...plan,
      entries: entriesWithMinutes,
    });
    return { ...plan, entries: entriesWithMinutes, summary };
  }

  async exportPlanExcel(hospitalId: string, planId: string): Promise<Buffer> {
    const plan: any = await this.getPlanDetails(hospitalId, planId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MaternityCare';
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet('Ish jadvali', {
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        paperSize: 9,
        margins: {
          left: 0.2,
          right: 0.2,
          top: 0.4,
          bottom: 0.4,
          header: 0.2,
          footer: 0.2,
        },
      },
      views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }],
    });
    const hours = (minutes: number) => Number((minutes / 60).toFixed(2));
    const daysInMonth = new Date(
      Date.UTC(plan.year, plan.month, 0),
    ).getUTCDate();
    // Kun ustunlaridan keyin: Kunduzgi (kun, soat), Kechki (kun, soat), Jami.
    const statsColumn = 4 + daysInMonth;
    const STATS_HEADERS = [
      'Kunduzgi (kun)',
      'Kunduzgi (soat)',
      'Kechki (kun)',
      'Kechki (soat)',
    ];
    const totalColumn = statsColumn + STATS_HEADERS.length;
    const summary = plan.summary ?? {};
    const postNormMinutes = summary.postNormMinutes ?? summary.targetMinutes;
    const postSlots = Math.max(1, summary.postSlots ?? 1);

    worksheet.mergeCells(1, 1, 1, totalColumn);
    worksheet.getCell(1, 1).value = plan.hospital?.name ?? 'Muassasa';
    worksheet.mergeCells(2, 1, 2, totalColumn);
    worksheet.getCell(2, 1).value =
      `${plan.post.department.name} — ${plan.year}-yil ${plan.month}-oy uchun`;
    worksheet.mergeCells(3, 1, 3, totalColumn);
    worksheet.getCell(3, 1).value = `ISH JADVALI — ${plan.post.name}`;
    worksheet.mergeCells(4, 1, 4, totalColumn);
    worksheet.getCell(4, 1).value =
      `Holat: ${plan.status} | Versiya: ${plan.version} | Post normasi: ${hours(postNormMinutes)} soat${postSlots > 1 ? ` × ${postSlots} post` : ''} | Yuklab olingan: ${dayjs().tz(TZ).format('DD.MM.YYYY HH:mm')}`;

    for (let row = 1; row <= 4; row += 1) {
      const cell = worksheet.getCell(row, 1);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = {
        name: 'Arial',
        size: row === 3 ? 14 : 10,
        bold: row <= 3,
      };
      worksheet.getRow(row).height = row === 3 ? 24 : 18;
    }

    const headerRow = worksheet.getRow(5);
    headerRow.values = ['№', 'F.I.Sh.', 'Lavozim'];
    for (let day = 1; day <= daysInMonth; day += 1) {
      headerRow.getCell(day + 3).value = day;
    }
    STATS_HEADERS.forEach((label, index) => {
      headerRow.getCell(statsColumn + index).value = label;
    });
    headerRow.getCell(totalColumn).value = 'Jami';
    headerRow.height = 30;

    type EmployeeRow = {
      employee: any;
      values: Map<number, number | string>;
      minutesByDay: Map<number, number>;
      totalMinutes: number;
      countsTowardPostCoverage: boolean;
      flagFromOwnEntry: boolean;
    };
    const employeeRows = new Map<string, EmployeeRow>();
    for (const entry of plan.entries) {
      let employeeRow = employeeRows.get(entry.employeeId);
      if (!employeeRow) {
        employeeRow = {
          employee: entry.employee,
          values: new Map(),
          minutesByDay: new Map(),
          totalMinutes: 0,
          countsTowardPostCoverage: entry.countsTowardPostCoverage !== false,
          flagFromOwnEntry: !entry.isCarryIn,
        };
        employeeRows.set(entry.employeeId, employeeRow);
      } else if (!employeeRow.flagFromOwnEntry && !entry.isCarryIn) {
        // Post/postdan tashqari belgisi shu oyning o'z katagidan olinadi,
        // oldingi oydan o'tgan smenadan emas.
        employeeRow.countsTowardPostCoverage =
          entry.countsTowardPostCoverage !== false;
        employeeRow.flagFromOwnEntry = true;
      }
      if (entry.entryType === SchedulePlanEntryType.WORKING) {
        for (const [date, minutes] of Object.entries(
          entry.calendarMinutes as Record<string, number>,
        )) {
          const day = Number(date.slice(-2));
          const dayMinutes = (employeeRow.minutesByDay.get(day) ?? 0) + minutes;
          employeeRow.minutesByDay.set(day, dayMinutes);
          employeeRow.values.set(day, dayMinutes / 60);
          employeeRow.totalMinutes += minutes;
        }
      } else {
        const localDate = localDateParts(entry.workDate);
        if (localDate.year === plan.year && localDate.month === plan.month) {
          employeeRow.values.set(
            localDate.day,
            this.entryTypeExcelCode(entry.entryType),
          );
        }
      }
    }

    const shiftStats = calculateEmployeeShiftStats(
      plan.entries,
      plan.year,
      plan.month,
    );
    const emptyStats = {
      dayShifts: 0,
      dayMinutes: 0,
      nightShifts: 0,
      nightMinutes: 0,
      totalMinutes: 0,
    };
    const statsCells = (stats: typeof emptyStats) => [
      stats.dayShifts,
      hours(stats.dayMinutes),
      stats.nightShifts,
      hours(stats.nightMinutes),
    ];
    const addStats = (target: typeof emptyStats, stats: typeof emptyStats) => {
      target.dayShifts += stats.dayShifts;
      target.dayMinutes += stats.dayMinutes;
      target.nightShifts += stats.nightShifts;
      target.nightMinutes += stats.nightMinutes;
      target.totalMinutes += stats.totalMinutes;
    };

    const postEmployees = [...employeeRows].filter(
      ([, item]) => item.countsTowardPostCoverage,
    );
    const outsideEmployees = [...employeeRows].filter(
      ([, item]) => !item.countsTowardPostCoverage,
    );
    const withSections = outsideEmployees.length > 0;

    let rowNumber = 6;
    let index = 1;
    const rowByEmployee = new Map<string, number>();
    const sectionRows: number[] = [];
    const sectionHeader = (title: string) => {
      worksheet.mergeCells(rowNumber, 1, rowNumber, totalColumn);
      worksheet.getCell(rowNumber, 1).value = title;
      sectionRows.push(rowNumber);
      rowNumber += 1;
    };
    const writeEmployees = (
      list: Array<[string, EmployeeRow]>,
      totals: typeof emptyStats,
      byDay: Map<number, number>,
    ) => {
      for (const [employeeId, item] of list) {
        rowByEmployee.set(employeeId, rowNumber);
        const row = worksheet.getRow(rowNumber);
        row.getCell(1).value = index;
        row.getCell(2).value = item.employee.fullName;
        row.getCell(3).value = item.employee.position?.name ?? '';
        for (let day = 1; day <= daysInMonth; day += 1) {
          row.getCell(day + 3).value = item.values.get(day) ?? '';
          byDay.set(
            day,
            (byDay.get(day) ?? 0) + (item.minutesByDay.get(day) ?? 0),
          );
        }
        const stats = shiftStats[employeeId] ?? emptyStats;
        statsCells(stats).forEach((value, offset) => {
          row.getCell(statsColumn + offset).value = value;
        });
        addStats(totals, stats);
        row.getCell(totalColumn).value = hours(item.totalMinutes);
        row.height = 21;
        rowNumber += 1;
        index += 1;
      }
    };

    const postTotals = { ...emptyStats };
    const outsideTotals = { ...emptyStats };
    const outsideByDay = new Map<number, number>();
    if (withSections && postEmployees.length) {
      sectionHeader('POST XODIMLARI');
    }
    writeEmployees(postEmployees, postTotals, new Map());
    if (withSections) {
      sectionHeader('POSTDAN TASHQARI XODIMLAR — post normasiga kirmaydi');
      writeEmployees(outsideEmployees, outsideTotals, outsideByDay);
    }
    const lastEmployeeRow = rowNumber - 1;

    let cursor = rowNumber + 1;
    const postTotalRow = worksheet.getRow(cursor);
    postTotalRow.getCell(1).value = 'POST JAMI';
    worksheet.mergeCells(cursor, 1, cursor, 3);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${plan.year}-${String(plan.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      postTotalRow.getCell(day + 3).value = hours(summary.byDate?.[date] ?? 0);
    }
    statsCells(postTotals).forEach((value, offset) => {
      postTotalRow.getCell(statsColumn + offset).value = value;
    });
    postTotalRow.getCell(totalColumn).value = hours(summary.plannedMinutes);
    const boldRows = [cursor];
    cursor += 1;

    if (withSections) {
      const outsideRow = worksheet.getRow(cursor);
      outsideRow.getCell(1).value = 'POSTDAN TASHQARI JAMI';
      worksheet.mergeCells(cursor, 1, cursor, 3);
      for (let day = 1; day <= daysInMonth; day += 1) {
        outsideRow.getCell(day + 3).value = hours(outsideByDay.get(day) ?? 0);
      }
      statsCells(outsideTotals).forEach((value, offset) => {
        outsideRow.getCell(statsColumn + offset).value = value;
      });
      outsideRow.getCell(totalColumn).value = hours(outsideTotals.totalMinutes);
      boldRows.push(cursor);
      cursor += 1;
    }

    const targetRowNumber = cursor;
    const targetRow = worksheet.getRow(cursor);
    targetRow.getCell(1).value =
      postSlots > 1
        ? `POST NORMASI — ${postSlots} post × ${hours(postNormMinutes)} soat`
        : 'POST NORMASI';
    worksheet.mergeCells(cursor, 1, cursor, totalColumn - 1);
    targetRow.getCell(totalColumn).value = hours(summary.targetMinutes);
    boldRows.push(cursor);
    const lastTableRow = cursor;
    cursor += 1;

    // Ortib qolgan soatlar haqida eslatma. Dastur xodimni o'zi postdan
    // tashqari qilmaydi — foydalanuvchiga nima qilish kerakligini aytadi.
    if (summary.postCoverageRequired && summary.remainingMinutes > 0) {
      worksheet.mergeCells(cursor, 1, cursor, totalColumn);
      const note = worksheet.getCell(cursor, 1);
      note.value = summary.fullPostCount
        ? `${summary.fullPostCount} ta post to‘liq (${hours(summary.fullPostCount * postNormMinutes)} soat), ${hours(summary.remainderMinutes)} soat ortib qoldi: oxirgi postni ${hours(postNormMinutes)} soatga to‘ldiring (yana ${hours(summary.missingMinutes)} soat) yoki ortiqcha xodimni «Postdan tashqari» deb belgilang.`
        : `Post normasigacha yana ${hours(summary.missingMinutes)} soat rejalashtirilishi kerak.`;
      note.font = {
        name: 'Arial',
        size: 9,
        bold: true,
        color: { argb: 'FFC00000' },
      };
      cursor += 1;
    }

    const legendRowNumber = cursor;
    const approvalRow = worksheet.getRow(cursor + 1);
    approvalRow.getCell(1).value = 'Bo‘lim mudiri:';
    approvalRow.getCell(Math.max(5, totalColumn - 8)).value = 'Tasdiqlayman:';
    const approvalInfoRow = worksheet.getRow(cursor + 2);
    approvalInfoRow.getCell(Math.max(5, totalColumn - 3)).value =
      plan.approvedAt
        ? dayjs(plan.approvedAt).tz(TZ).format('DD.MM.YYYY HH:mm')
        : '';
    const lastPrintRow = cursor + 2;

    worksheet.getColumn(1).width = 5;
    worksheet.getColumn(2).width = 28;
    worksheet.getColumn(3).width = 18;
    for (let day = 1; day <= daysInMonth; day += 1) {
      worksheet.getColumn(day + 3).width = 4;
    }
    for (let offset = 0; offset < STATS_HEADERS.length; offset += 1) {
      worksheet.getColumn(statsColumn + offset).width = 8;
    }
    worksheet.getColumn(totalColumn).width = 8;

    const border: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } },
    };
    for (let row = 5; row <= lastTableRow; row += 1) {
      for (let column = 1; column <= totalColumn; column += 1) {
        const cell = worksheet.getCell(row, column);
        cell.border = border;
        cell.alignment = {
          horizontal:
            (column === 2 || column === 3) && !sectionRows.includes(row)
              ? 'left'
              : 'center',
          vertical: 'middle',
          wrapText: true,
        };
        cell.font = {
          name: 'Arial',
          size: 9,
          bold:
            row === 5 || sectionRows.includes(row) || boldRows.includes(row),
        };
      }
    }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    for (const row of sectionRows) {
      worksheet.getCell(row, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEDEDED' },
      };
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const weekday = new Date(
        Date.UTC(plan.year, plan.month - 1, day),
      ).getUTCDay();
      if (weekday === 0 || weekday === 6) {
        for (let row = 5; row < targetRowNumber; row += 1) {
          if (sectionRows.includes(row)) continue;
          worksheet.getCell(row, day + 3).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE7E6E6' },
          };
        }
      }
    }
    // Kunduzgi/kechki ustunlar ajralib turishi uchun och rang.
    for (let row = 5; row < targetRowNumber; row += 1) {
      if (sectionRows.includes(row)) continue;
      for (let offset = 0; offset < STATS_HEADERS.length; offset += 1) {
        worksheet.getCell(row, statsColumn + offset).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: offset < 2 ? 'FFFFF2CC' : 'FFDDEBF7' },
        };
      }
    }

    // Tasdiqlangan reja hujjat sifatida o'zgarmaydi; tasdiqdan keyingi
    // o'zgarishlar (almashish, o'rniga chiqish, ishga chiqmaslik) katakda
    // sariq rang + izoh bilan belgilanadi va "O'zgarishlar" varag'ida sanasi
    // bilan ro'yxatlanadi.
    const changes = this.approvedChangesForExcel(plan);
    const notesByCell = new Map<string, string[]>();
    changes.forEach((change, changeIndex) => {
      const seen = new Set<string>();
      for (const target of change.targets) {
        const row = rowByEmployee.get(target.employeeId);
        const local = localDateParts(target.workDate);
        if (!row || local.year !== plan.year || local.month !== plan.month) {
          continue;
        }
        const key = `${row}:${local.day + 3}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const notes = notesByCell.get(key) ?? [];
        notes.push(
          `№${changeIndex + 1} ${change.typeLabel}: ${change.description}. Tasdiqlandi: ${change.approvedAtText}`,
        );
        notesByCell.set(key, notes);
      }
    });
    for (const [key, notes] of notesByCell) {
      const [row, column] = key.split(':').map(Number);
      const cell = worksheet.getCell(row, column);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFE699' },
      };
      cell.note = notes.join('\n');
    }
    const legendRow = worksheet.getRow(legendRowNumber);
    legendRow.getCell(1).value = changes.length
      ? `Sariq katak — tasdiqdan keyingi o‘zgarish (${changes.length} ta, oxirgisi ${changes[changes.length - 1].approvedAtText}). Batafsil: «O‘zgarishlar» varag‘i.`
      : 'Tasdiqdan keyin o‘zgarish kiritilmagan.';
    legendRow.getCell(1).font = { name: 'Arial', size: 9, italic: true };
    this.addChangesSheet(workbook, plan, changes);
    worksheet.autoFilter = {
      from: { row: 5, column: 1 },
      // Kun ustunlari ataylab filterdan tashqarida: 4 birlik tor kataklarda
      // dropdown tugmasi kun raqamini yopib qo'yadi. Xodimni qidirish/saralash
      // uchun №, F.I.Sh. va Lavozim ustunlari yetarli.
      to: { row: Math.max(5, lastEmployeeRow), column: 3 },
    };
    worksheet.pageSetup.printTitlesRow = '1:5';
    worksheet.pageSetup.printArea = `A1:${worksheet.getColumn(totalColumn).letter}${lastPrintRow}`;

    const output = await workbook.xlsx.writeBuffer();
    return Buffer.from(output);
  }

  async saveEntries(
    hospitalId: string,
    planId: string,
    dto: SaveSchedulePlanEntriesDto,
  ) {
    await this.requirePostCoverage(hospitalId);
    const plan = await this.prisma.monthlySchedulePlan.findFirst({
      where: { id: planId, hospitalId },
      include: { post: true },
    });
    if (!plan) throw new NotFoundException('Oylik grafik topilmadi');
    if (plan.status !== MonthlySchedulePlanStatus.DRAFT) {
      throw new BadRequestException(
        'Faqat qoralama grafik kataklarini tahrirlash mumkin',
      );
    }
    if (dto.entries.length > 2000) {
      throw new BadRequestException(
        'Bitta grafikda yozuvlar soni 2000 dan oshmasin',
      );
    }

    const employeeIds = Array.from(
      new Set(dto.entries.map((entry) => entry.employeeId)),
    );
    const employees = employeeIds.length
      ? await this.prisma.employee.findMany({
          where: {
            id: { in: employeeIds },
            hospitalId,
            departmentId: plan.post.departmentId,
            firedAt: null,
          },
          select: { id: true },
        })
      : [];
    if (employees.length !== employeeIds.length) {
      throw new BadRequestException(
        'Xodimlardan biri post bo‘limiga yoki tanlangan muassasaga tegishli emas',
      );
    }

    const shiftIds = Array.from(
      new Set(dto.entries.map((entry) => entry.shiftId).filter(Boolean)),
    ) as string[];
    const shifts = shiftIds.length
      ? await this.prisma.shiftTemplate.findMany({
          where: { id: { in: shiftIds }, hospitalId },
          select: { id: true },
        })
      : [];
    const validShiftIds = new Set(shifts.map((shift) => shift.id));
    if (validShiftIds.size !== shiftIds.length) {
      throw new BadRequestException(
        'Smenalardan biri tanlangan muassasaga tegishli emas',
      );
    }

    const monthStart = dayjs.tz(
      `${plan.year}-${String(plan.month).padStart(2, '0')}-01`,
      TZ,
    );
    const monthEnd = monthStart.add(1, 'month');
    // YYYY-MM-DD satrlari leksikografik tartibda sana tartibiga teng.
    const firstAllowedDay = monthStart.subtract(1, 'day').format('YYYY-MM-DD');
    const firstForbiddenDay = monthEnd.format('YYYY-MM-DD');
    const normalized = dto.entries.map((entry) => {
      const workDate = DateUtil.startOfDay(entry.workDate);
      const workDay = localDateParts(workDate).iso;
      if (workDay < firstAllowedDay || workDay >= firstForbiddenDay) {
        throw new BadRequestException(
          'Grafik sanasi tanlangan oy yoki oy boshidagi tungi smenaga mos emas',
        );
      }

      if (entry.entryType === SchedulePlanEntryType.WORKING) {
        if (!entry.shiftId || !entry.startsAt || !entry.endsAt) {
          throw new BadRequestException(
            'Ish kunida smena, boshlanish va tugash vaqti majburiy',
          );
        }
        const startsAt = new Date(entry.startsAt);
        const endsAt = new Date(entry.endsAt);
        const durationMinutes =
          (endsAt.getTime() - startsAt.getTime()) / 60_000;
        if (durationMinutes <= 0 || durationMinutes > 24 * 60) {
          throw new BadRequestException(
            'Smena davomiyligi 0 dan katta va 24 soatdan oshmagan bo‘lishi kerak',
          );
        }
        if (!validShiftIds.has(entry.shiftId)) {
          throw new BadRequestException('Smena topilmadi');
        }
        if (localDateParts(startsAt).iso !== workDay) {
          throw new BadRequestException(
            'Smena boshlanish sanasi grafik sanasiga mos emas',
          );
        }
        return {
          hospitalId,
          planId,
          employeeId: entry.employeeId,
          shiftId: entry.shiftId,
          entryType: entry.entryType,
          countsTowardPostCoverage: entry.countsTowardPostCoverage !== false,
          workDate,
          startsAt,
          endsAt,
          note: entry.note?.trim() || null,
        };
      }

      return {
        hospitalId,
        planId,
        employeeId: entry.employeeId,
        shiftId: null,
        entryType: entry.entryType,
        countsTowardPostCoverage: entry.countsTowardPostCoverage !== false,
        workDate,
        startsAt: null,
        endsAt: null,
        note: entry.note?.trim() || null,
      };
    });

    const coverageRoleByEmployee = new Map<string, boolean>();
    for (const entry of normalized) {
      const existing = coverageRoleByEmployee.get(entry.employeeId);
      if (
        existing !== undefined &&
        existing !== entry.countsTowardPostCoverage
      ) {
        throw new BadRequestException(
          'Bir xodim bitta reja ichida ham post xodimi, ham postdan tashqari bo‘la olmaydi',
        );
      }
      coverageRoleByEmployee.set(
        entry.employeeId,
        entry.countsTowardPostCoverage,
      );
    }

    const effectiveEntries = await this.withCanonicalCarryIn(
      hospitalId,
      plan.postId,
      plan.year,
      plan.month,
      normalized,
    );
    const effectiveEmployeeIds = Array.from(
      new Set(effectiveEntries.map((entry) => entry.employeeId)),
    );

    const uniqueDayKeys = new Set<string>();
    for (const entry of effectiveEntries) {
      const key = `${entry.employeeId}:${localDateParts(entry.workDate).iso}`;
      if (uniqueDayKeys.has(key)) {
        throw new BadRequestException(
          'Bir xodimga bir kunda bittadan ortiq grafik katagi berilmaydi',
        );
      }
      uniqueDayKeys.add(key);
    }
    assertNoEmployeeOverlaps(effectiveEntries);

    await this.prisma.$transaction(
      async (tx) => {
        // Bir muassasada rejalar ketma-ket yoziladi: ikki post bir vaqtda
        // saqlansa ham bitta xodim ikki joyga tushib qolmaydi.
        await this.lockPlanning(tx, hospitalId);

        // Reja hali qoralama va (versiya berilgan bo'lsa) orada boshqa
        // foydalanuvchi saqlamagan bo'lishi shart.
        const claimed = await tx.monthlySchedulePlan.updateMany({
          where: {
            id: planId,
            hospitalId,
            status: MonthlySchedulePlanStatus.DRAFT,
            ...(dto.expectedUpdatedAt
              ? { updatedAt: new Date(dto.expectedUpdatedAt) }
              : {}),
          },
          data: { updatedAt: new Date() },
        });
        if (!claimed.count) {
          throw new ConflictException(
            'Grafik boshqa foydalanuvchi tomonidan o‘zgartirilgan yoki endi qoralama emas. Sahifani yangilab, qayta urinib ko‘ring.',
          );
        }

        const otherEntries = effectiveEmployeeIds.length
          ? await tx.monthlyScheduleEntry.findMany({
              where: {
                hospitalId,
                planId: { not: planId },
                employeeId: { in: effectiveEmployeeIds },
                workDate: {
                  // Oldingi oyning eng so‘nggi faol tungi smenasi canonical
                  // carry-in sifatida alohida olinadi. Shu sabab boshqa
                  // rejalarning faqat joriy oy kataklari collision tekshiruviga
                  // kiradi; carry-in qayta publish qilinmaydi.
                  gte: monthStart.toDate(),
                  lt: monthEnd.toDate(),
                },
                plan: {
                  status: {
                    in: [
                      MonthlySchedulePlanStatus.DRAFT,
                      MonthlySchedulePlanStatus.SUBMITTED,
                      MonthlySchedulePlanStatus.APPROVED,
                    ],
                  },
                },
              },
              select: {
                id: true,
                employeeId: true,
                entryType: true,
                workDate: true,
                startsAt: true,
                endsAt: true,
              },
            })
          : [];
        const otherDayKeys = new Set(
          otherEntries.map(
            (entry) =>
              `${entry.employeeId}:${localDateParts(entry.workDate).iso}`,
          ),
        );
        if ([...uniqueDayKeys].some((key) => otherDayKeys.has(key))) {
          throw new BadRequestException(
            'Xodimga boshqa post grafigida shu kun uchun smena biriktirilgan',
          );
        }
        assertNoEmployeeOverlaps([...effectiveEntries, ...otherEntries]);

        await this.replacePlanEntries(tx, planId, normalized);
      },
      { maxWait: 15_000, timeout: 60_000 },
    );
    return this.getPlanDetails(hospitalId, planId);
  }

  /**
   * Reja kataklarini yangi ro'yxatga moslaydi. Hammasini o'chirib qayta
   * yaratish o'rniga faqat farq qo'llanadi: mavjud kataklar id'si saqlanadi
   * (smena so'rovlari va nashr qilingan grafik ularga bog'langan), smena
   * so'rovi bog'langan katakni esa o'chirib bo'lmaydi.
   */
  private async replacePlanEntries(
    tx: Prisma.TransactionClient,
    planId: string,
    entries: Array<{
      hospitalId: string;
      planId: string;
      employeeId: string;
      shiftId: string | null;
      entryType: SchedulePlanEntryType;
      countsTowardPostCoverage: boolean;
      workDate: Date;
      startsAt: Date | null;
      endsAt: Date | null;
      note: string | null;
    }>,
  ) {
    const dayKey = (employeeId: string, workDate: Date) =>
      `${employeeId}:${localDateParts(workDate).iso}`;
    const existing = await tx.monthlyScheduleEntry.findMany({
      where: { planId },
      select: {
        id: true,
        employeeId: true,
        workDate: true,
        shiftId: true,
        entryType: true,
        countsTowardPostCoverage: true,
        startsAt: true,
        endsAt: true,
        note: true,
      },
    });
    const existingByKey = new Map(
      existing.map((entry) => [
        dayKey(entry.employeeId, entry.workDate),
        entry,
      ]),
    );

    const toCreate: typeof entries = [];
    const keep = new Set<string>();
    const sameTime = (a: Date | null, b: Date | null) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    for (const entry of entries) {
      const key = dayKey(entry.employeeId, entry.workDate);
      const current = existingByKey.get(key);
      if (!current) {
        toCreate.push(entry);
        continue;
      }
      keep.add(current.id);
      const unchanged =
        current.shiftId === entry.shiftId &&
        current.entryType === entry.entryType &&
        current.countsTowardPostCoverage === entry.countsTowardPostCoverage &&
        sameTime(current.startsAt, entry.startsAt) &&
        sameTime(current.endsAt, entry.endsAt) &&
        (current.note ?? null) === entry.note;
      if (!unchanged) {
        await tx.monthlyScheduleEntry.update({
          where: { id: current.id },
          data: {
            shiftId: entry.shiftId,
            entryType: entry.entryType,
            countsTowardPostCoverage: entry.countsTowardPostCoverage,
            startsAt: entry.startsAt,
            endsAt: entry.endsAt,
            note: entry.note,
          },
        });
      }
    }

    const removedIds = existing
      .filter((entry) => !keep.has(entry.id))
      .map((entry) => entry.id);
    if (removedIds.length) {
      const referenced = await tx.scheduleChangeRequest.findMany({
        where: { primaryEntryId: { in: removedIds } },
        select: {
          primaryEntry: {
            select: {
              workDate: true,
              employee: { select: { fullName: true } },
            },
          },
        },
        take: 3,
      });
      if (referenced.length) {
        const cells = referenced
          .map(
            (item) =>
              `${item.primaryEntry.employee.fullName} — ${dayjs(item.primaryEntry.workDate).tz(TZ).format('DD.MM')}`,
          )
          .join(', ');
        throw new ConflictException(
          `Smena o‘zgarishi so‘rovi bog‘langan katakni o‘chirib bo‘lmaydi: ${cells}. Katakni o‘chirmasdan, smenasini o‘zgartiring.`,
        );
      }
      await tx.monthlyScheduleEntry.deleteMany({
        where: { id: { in: removedIds } },
      });
    }
    if (toCreate.length) {
      await tx.monthlyScheduleEntry.createMany({ data: toCreate });
    }
  }

  /** Bir muassasaning post grafik amallarini tranzaksiya oxirigacha ketma-ket qiladi */
  private async lockPlanning(tx: Prisma.TransactionClient, hospitalId: string) {
    const key = `schedule-planning:${hospitalId}`;
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) AS l`;
  }

  async submitPlan(hospitalId: string, planId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPlanning(tx, hospitalId);
      // Qulfdan keyin o'qiladi: parallel saqlash tugagan bo'ladi va norma
      // aynan yuboriladigan kataklar bo'yicha tekshiriladi.
      const plan = await this.getPlanForWorkflow(hospitalId, planId);
      if (plan.status !== MonthlySchedulePlanStatus.DRAFT) {
        throw new BadRequestException('Faqat qoralama grafik yuboriladi');
      }
      this.assertPlanReadyForReview(plan);
      await this.transitionPlan(
        tx,
        hospitalId,
        planId,
        MonthlySchedulePlanStatus.DRAFT,
        {
          status: MonthlySchedulePlanStatus.SUBMITTED,
          submittedAt: new Date(),
          decisionNote: null,
        },
      );
      return tx.monthlySchedulePlan.findUnique({ where: { id: planId } });
    });
  }

  async approvePlan(hospitalId: string, planId: string, approvedById: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockPlanning(tx, hospitalId);
        const plan = await this.getPlanForWorkflow(hospitalId, planId);
        if (plan.status !== MonthlySchedulePlanStatus.SUBMITTED) {
          throw new BadRequestException(
            'Faqat tasdiqlashga yuborilgan grafik tasdiqlanadi',
          );
        }
        this.assertPlanReadyForReview(plan);
        // Holat birinchi bo'lib almashtiriladi: ikkinchi (parallel yoki
        // takroriy) tasdiqlash shu yerda to'xtaydi.
        await this.transitionPlan(
          tx,
          hospitalId,
          planId,
          MonthlySchedulePlanStatus.SUBMITTED,
          {
            status: MonthlySchedulePlanStatus.APPROVED,
            approvedById,
            approvedAt: new Date(),
            decisionNote: null,
          },
        );

        // Oldingi oyning oxirida boshlangan carry-in smena o'sha oy grafigi
        // tomonidan nashr qilinadi; bu oy faqat Excel/qamrovda uning qismini oladi.
        const monthEntries = plan.entries.filter((entry) => {
          const workDay = localDateParts(entry.workDate);
          return workDay.year === plan.year && workDay.month === plan.month;
        });
        const existing = monthEntries.length
          ? await tx.schedule.findMany({
              where: {
                employeeId: {
                  in: [...new Set(monthEntries.map((e) => e.employeeId))],
                },
                date: { in: [...new Set(monthEntries.map((e) => e.workDate))] },
              },
              select: {
                employeeId: true,
                date: true,
                status: true,
                note: true,
              },
            })
          : [];
        const existingByKey = new Map(
          existing.map((row) => [
            `${row.employeeId}:${row.date.getTime()}`,
            row,
          ]),
        );

        const leaveConflicts: Array<{
          employeeId: string;
          date: Date;
          leaveStatus: ScheduleStatus;
        }> = [];
        for (const entry of monthEntries) {
          const where = {
            employeeId_date: {
              employeeId: entry.employeeId,
              date: entry.workDate,
            },
          };
          const planned = this.mapEntryTypeToScheduleStatus(entry.entryType);
          const current = existingByKey.get(
            `${entry.employeeId}:${entry.workDate.getTime()}`,
          );
          if (current && isLeaveWrittenSchedule(current)) {
            // Tasdiqlangan ta'til ustidan yozilmaydi. Reja holati
            // preLeaveStatus'ga qo'yiladi — ta'til qaytarilsa, kun reja
            // bo'yicha tiklanadi. Post qamrovidagi bo'shliq rahbarga
            // ko'rsatiladi.
            await tx.schedule.update({
              where,
              data: {
                shiftId: entry.shiftId,
                preLeaveStatus: planned,
                sourcePlanId: plan.id,
                sourceEntryId: entry.id,
                scheduleChangeRequestId: null,
              },
            });
            if (planned === ScheduleStatus.WORKING) {
              leaveConflicts.push({
                employeeId: entry.employeeId,
                date: entry.workDate,
                leaveStatus: current.status,
              });
            }
            continue;
          }
          await tx.schedule.upsert({
            where,
            create: {
              employeeId: entry.employeeId,
              shiftId: entry.shiftId,
              date: entry.workDate,
              status: planned,
              note: entry.note,
              sourcePlanId: plan.id,
              sourceEntryId: entry.id,
            },
            update: {
              shiftId: entry.shiftId,
              status: planned,
              note: entry.note,
              sourcePlanId: plan.id,
              sourceEntryId: entry.id,
              scheduleChangeRequestId: null,
            },
          });
        }

        const approved = await tx.monthlySchedulePlan.findUnique({
          where: { id: plan.id },
        });
        return { ...approved, leaveConflicts };
      },
      // Katta rejada yuzlab yozuv bitta tranzaksiyada yoziladi
      { maxWait: 15_000, timeout: 60_000 },
    );
  }

  async reopenApprovedPlan(hospitalId: string, planId: string, reason: string) {
    await this.requirePostCoverage(hospitalId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockPlanning(tx, hospitalId);
      const plan = await tx.monthlySchedulePlan.findFirst({
        where: { id: planId, hospitalId },
        select: {
          id: true,
          year: true,
          month: true,
          status: true,
        },
      });
      if (!plan) throw new NotFoundException('Oylik grafik topilmadi');
      if (plan.status !== MonthlySchedulePlanStatus.APPROVED) {
        throw new BadRequestException(
          'Faqat tasdiqlangan grafik qayta tahrirlashga ochiladi',
        );
      }

      const monthStart = dayjs
        .tz(`${plan.year}-${String(plan.month).padStart(2, '0')}-01`, TZ)
        .startOf('day');
      if (!dayjs().tz(TZ).startOf('day').isBefore(monthStart)) {
        throw new BadRequestException(
          'Boshlangan yoki o‘tgan oy grafigini qayta ochib bo‘lmaydi',
        );
      }

      const attendanceCount = await tx.attendanceRecord.count({
        where: { schedule: { sourcePlanId: plan.id } },
      });
      if (attendanceCount) {
        throw new ConflictException(
          'Grafikka bog‘langan davomat mavjud; uni qayta ochib bo‘lmaydi',
        );
      }

      // Tasdiqlangan smena o'zgarishi amaldagi grafikni allaqachon
      // o'zgartirgan — rejani qayta ochish uni jimgina bekor qilib yuborardi.
      const approvedChanges = await tx.scheduleChangeRequest.count({
        where: { planId: plan.id, status: ScheduleChangeStatus.APPROVED },
      });
      if (approvedChanges) {
        throw new ConflictException(
          'Bu grafikda tasdiqlangan smena o‘zgarishlari bor. Qayta ochish o‘rniga yangi smena o‘zgarishi so‘rovidan foydalaning.',
        );
      }

      await this.transitionPlan(
        tx,
        hospitalId,
        plan.id,
        MonthlySchedulePlanStatus.APPROVED,
        {
          status: MonthlySchedulePlanStatus.DRAFT,
          submittedAt: null,
          approvedById: null,
          approvedAt: null,
          decisionNote: `Qayta tahrirlash: ${reason.trim()}`,
        },
      );
      // Kutilayotgan so'rovlar qoralama grafikda qolib ketmasin
      await tx.scheduleChangeRequest.updateMany({
        where: {
          planId: plan.id,
          status: {
            in: [ScheduleChangeStatus.REQUESTED, ScheduleChangeStatus.ACCEPTED],
          },
        },
        data: {
          status: ScheduleChangeStatus.CANCELLED,
          decisionNote: 'Grafik qayta tahrirlashga ochildi',
        },
      });
      // Ta'til yozgan kunlar o'chirilmaydi — faqat rejadan uziladi.
      const leaveWritten: Prisma.ScheduleWhereInput = {
        status: { in: LEAVE_WRITTEN_STATUSES },
        note: { startsWith: LEAVE_NOTE_PREFIX },
      };
      await tx.schedule.updateMany({
        where: { sourcePlanId: plan.id, ...leaveWritten },
        data: {
          sourcePlanId: null,
          sourceEntryId: null,
          shiftId: null,
          preLeaveStatus: null,
        },
      });
      await tx.schedule.deleteMany({
        where: { sourcePlanId: plan.id, NOT: leaveWritten },
      });
      return tx.monthlySchedulePlan.findUnique({ where: { id: plan.id } });
    });
  }

  async rejectPlan(
    hospitalId: string,
    planId: string,
    approvedById: string,
    reason: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPlanning(tx, hospitalId);
      const plan = await this.getPlanForWorkflow(hospitalId, planId);
      if (plan.status !== MonthlySchedulePlanStatus.SUBMITTED) {
        throw new BadRequestException(
          'Faqat tasdiqlashga yuborilgan grafik rad etiladi',
        );
      }
      await this.transitionPlan(
        tx,
        hospitalId,
        plan.id,
        MonthlySchedulePlanStatus.SUBMITTED,
        {
          status: MonthlySchedulePlanStatus.REJECTED,
          approvedById,
          approvedAt: new Date(),
          decisionNote: reason.trim(),
        },
      );
      return tx.monthlySchedulePlan.findUnique({ where: { id: plan.id } });
    });
  }

  /**
   * Reja holatini faqat kutilgan holatdan o'tkazadi. Boshqa so'rov holatni
   * allaqachon o'zgartirgan bo'lsa (ikki marta bosish, ikki rahbar) — 409.
   */
  private async transitionPlan(
    tx: Prisma.TransactionClient,
    hospitalId: string,
    planId: string,
    from: MonthlySchedulePlanStatus,
    data: Prisma.MonthlySchedulePlanUncheckedUpdateManyInput,
  ) {
    const result = await tx.monthlySchedulePlan.updateMany({
      where: { id: planId, hospitalId, status: from },
      data,
    });
    if (!result.count) {
      throw new ConflictException(
        'Grafik holati allaqachon o‘zgargan. Sahifani yangilang.',
      );
    }
  }

  async createChangeRequest(
    hospitalId: string,
    requestedById: string,
    requesterRole: UserRole,
    dto: CreateScheduleChangeDto,
  ) {
    await this.requirePostCoverage(hospitalId);
    const primary = await this.prisma.monthlyScheduleEntry.findFirst({
      where: { id: dto.primaryEntryId, hospitalId },
      include: {
        plan: true,
        employee: { select: { id: true, userId: true, departmentId: true } },
      },
    });
    if (
      !primary ||
      primary.plan.status !== MonthlySchedulePlanStatus.APPROVED
    ) {
      throw new BadRequestException(
        'Faqat tasdiqlangan grafik smenasi o‘zgartiriladi',
      );
    }
    if (
      primary.entryType !== SchedulePlanEntryType.WORKING ||
      !primary.shiftId ||
      !primary.startsAt ||
      !primary.endsAt
    ) {
      throw new BadRequestException(
        'Faqat ish smenasi o‘rnini bosiladi yoki almashtiriladi',
      );
    }
    this.assertChangeDateInWindow(primary.workDate);

    const allowedAbsenceTypes: SchedulePlanEntryType[] = [
      SchedulePlanEntryType.DAY_OFF,
      SchedulePlanEntryType.SICK,
      SchedulePlanEntryType.VACATION,
      SchedulePlanEntryType.MATERNITY_LEAVE,
      SchedulePlanEntryType.TRAINING,
      SchedulePlanEntryType.OTHER_ABSENCE,
    ];
    if (
      dto.absenceEntryType &&
      !allowedAbsenceTypes.includes(dto.absenceEntryType)
    ) {
      throw new BadRequestException('Yo‘qlik turi noto‘g‘ri');
    }
    if (
      requesterRole === UserRole.EMPLOYEE &&
      primary.employee.userId !== requestedById
    ) {
      throw new BadRequestException(
        'Faqat o‘z smenangiz uchun so‘rov yuboring',
      );
    }

    let counterpart = null;
    let replacementEmployeeId = dto.replacementEmployeeId;
    if (dto.type === ScheduleChangeType.SWAP) {
      if (!dto.counterpartEntryId) {
        throw new BadRequestException(
          'Almashiladigan ikkinchi smenani tanlang',
        );
      }
      counterpart = await this.prisma.monthlyScheduleEntry.findFirst({
        where: {
          id: dto.counterpartEntryId,
          hospitalId,
          planId: primary.planId,
        },
        include: { plan: true, employee: true },
      });
      if (
        !counterpart ||
        counterpart.plan.status !== MonthlySchedulePlanStatus.APPROVED ||
        counterpart.entryType !== SchedulePlanEntryType.WORKING ||
        !counterpart.shiftId ||
        dayjs(counterpart.workDate)
          .tz(TZ)
          .isBefore(dayjs().tz(TZ).startOf('day')) ||
        counterpart.employeeId === primary.employeeId
      ) {
        throw new BadRequestException('Almashiladigan smena noto‘g‘ri');
      }
      this.assertChangeDateInWindow(counterpart.workDate);
      replacementEmployeeId = counterpart.employeeId;
    } else if (dto.type === ScheduleChangeType.SUBSTITUTION) {
      if (!replacementEmployeeId) {
        throw new BadRequestException('O‘rnini bosadigan xodimni tanlang');
      }
    }

    const involvedEntryIds = [primary.id, counterpart?.id].filter(
      (id): id is string => Boolean(id),
    );
    const pendingRequest = await this.prisma.scheduleChangeRequest.findFirst({
      where: {
        hospitalId,
        status: {
          in: [ScheduleChangeStatus.REQUESTED, ScheduleChangeStatus.ACCEPTED],
        },
        OR: [
          { primaryEntryId: { in: involvedEntryIds } },
          { counterpartEntryId: { in: involvedEntryIds } },
        ],
      },
      select: { id: true },
    });
    if (pendingRequest) {
      throw new ConflictException(
        'Tanlangan smena uchun yakunlanmagan o‘zgarish so‘rovi mavjud',
      );
    }

    if (replacementEmployeeId) {
      const replacement = await this.prisma.employee.findFirst({
        where: {
          id: replacementEmployeeId,
          hospitalId,
          departmentId: primary.employee.departmentId,
          firedAt: null,
        },
        select: { id: true, userId: true },
      });
      if (!replacement || replacement.id === primary.employeeId) {
        throw new BadRequestException('O‘rnini bosadigan xodim noto‘g‘ri');
      }
    }

    const created = await this.prisma.scheduleChangeRequest.create({
      data: {
        hospitalId,
        planId: primary.planId,
        type: dto.type,
        primaryEntryId: primary.id,
        counterpartEntryId: counterpart?.id,
        replacementEmployeeId,
        absenceEntryType: dto.absenceEntryType,
        reason: dto.reason.trim(),
        requestedById,
      },
      include: {
        primaryEntry: { include: { employee: true, shift: true } },
        counterpartEntry: { include: { employee: true, shift: true } },
        replacementEmployee: true,
      },
    });

    const targetUserId =
      dto.type === ScheduleChangeType.SWAP
        ? counterpart?.employee?.userId
        : created.replacementEmployee?.userId;
    const supervisors = await this.prisma.user.findMany({
      where: {
        hospitalId,
        role: { in: [UserRole.DIRECTOR, UserRole.ADMIN] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    await this.notifications?.createForUsers(
      [targetUserId, ...supervisors.map((user) => user.id)].filter(
        (id): id is string => Boolean(id),
      ),
      {
        type: NotificationType.SYSTEM,
        title: 'Smena o‘zgarishi so‘rovi',
        message: `${created.primaryEntry.employee.fullName}: ${created.reason}`,
        metadata: { scheduleChangeRequestId: created.id },
      },
    );
    await this.notifications?.sendWorkflowTelegram(
      hospitalId,
      [targetUserId].filter((id): id is string => Boolean(id)),
      'Yangi smena almashish yoki o‘rinbosarlik so‘rovi yaratildi. Tafsilotlarni StaffPlusPRO ilovasida ko‘ring.',
    );

    return created;
  }

  async listMyChangeRequests(hospitalId: string, userId: string) {
    await this.requirePostCoverage(hospitalId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { employee: { select: { id: true } } },
    });
    const employeeId = user?.employee?.id;
    if (!employeeId) {
      throw new NotFoundException('Xodim profili topilmadi');
    }

    const requests = await this.prisma.scheduleChangeRequest.findMany({
      where: {
        hospitalId,
        OR: [
          { requestedById: userId },
          { replacementEmployeeId: employeeId },
          { primaryEntry: { employeeId } },
          { counterpartEntry: { employeeId } },
        ],
      },
      include: {
        primaryEntry: { include: { employee: true, shift: true } },
        counterpartEntry: { include: { employee: true, shift: true } },
        replacementEmployee: true,
        requestedBy: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return requests.map((request) => ({
      ...request,
      canAccept:
        request.status === ScheduleChangeStatus.REQUESTED &&
        (request.type === ScheduleChangeType.SWAP
          ? request.counterpartEntry?.employeeId === employeeId
          : request.type === ScheduleChangeType.SUBSTITUTION
            ? request.replacementEmployeeId === employeeId
            : false),
    }));
  }

  async getMyChangeOptions(
    hospitalId: string,
    userId: string,
    entryId: string,
  ) {
    await this.requirePostCoverage(hospitalId);
    const primary = await this.prisma.monthlyScheduleEntry.findFirst({
      where: { id: entryId, hospitalId },
      include: {
        plan: true,
        employee: {
          select: {
            id: true,
            userId: true,
            departmentId: true,
            fullName: true,
          },
        },
        shift: true,
      },
    });
    if (!primary || primary.employee.userId !== userId) {
      throw new BadRequestException('Faqat o‘z smenangizni tanlang');
    }
    if (
      primary.plan.status !== MonthlySchedulePlanStatus.APPROVED ||
      primary.entryType !== SchedulePlanEntryType.WORKING
    ) {
      throw new BadRequestException(
        'Faqat tasdiqlangan ish smenasi uchun so‘rov yuboriladi',
      );
    }
    this.assertChangeDateInWindow(primary.workDate);

    const [replacementEmployees, counterpartEntries] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          hospitalId,
          departmentId: primary.employee.departmentId,
          firedAt: null,
          id: { not: primary.employeeId },
          userId: { not: null },
        },
        select: {
          id: true,
          fullName: true,
          position: { select: { name: true } },
        },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.monthlyScheduleEntry.findMany({
        where: {
          planId: primary.planId,
          employeeId: { not: primary.employeeId },
          entryType: SchedulePlanEntryType.WORKING,
          workDate: { gte: DateUtil.startOfDay(new Date()) },
        },
        include: {
          employee: { select: { id: true, fullName: true } },
          shift: true,
        },
        orderBy: [{ workDate: 'asc' }, { employee: { fullName: 'asc' } }],
      }),
    ]);

    return { primary, replacementEmployees, counterpartEntries };
  }

  async acceptChangeRequest(
    hospitalId: string,
    requestId: string,
    userId: string,
  ) {
    await this.requirePostCoverage(hospitalId);
    const request = await this.prisma.scheduleChangeRequest.findFirst({
      where: { id: requestId, hospitalId },
      include: {
        primaryEntry: true,
        replacementEmployee: { select: { userId: true } },
        counterpartEntry: {
          include: { employee: { select: { userId: true } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Smena o‘zgarishi topilmadi');
    this.assertChangeDateInWindow(request.primaryEntry.workDate);
    if (request.counterpartEntry) {
      this.assertChangeDateInWindow(request.counterpartEntry.workDate);
    }
    if (request.status !== ScheduleChangeStatus.REQUESTED) {
      throw new BadRequestException('Bu so‘rovni qabul qilib bo‘lmaydi');
    }
    const expectedUserId =
      request.type === ScheduleChangeType.SWAP
        ? request.counterpartEntry?.employee?.userId
        : request.replacementEmployee?.userId;
    if (!expectedUserId || expectedUserId !== userId) {
      throw new BadRequestException(
        'Bu smena o‘zgarishini faqat tanlangan xodim qabul qiladi',
      );
    }
    const updated = await this.prisma.scheduleChangeRequest.update({
      where: { id: request.id },
      data: {
        status: ScheduleChangeStatus.ACCEPTED,
        acceptedById: userId,
        acceptedAt: new Date(),
      },
    });
    const supervisors = await this.prisma.user.findMany({
      where: {
        hospitalId,
        role: { in: [UserRole.DIRECTOR, UserRole.ADMIN] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    await this.notifications?.createForUsers(
      [request.requestedById, ...supervisors.map((user) => user.id)],
      {
        type: NotificationType.SYSTEM,
        title: 'Smena so‘rovi qabul qilindi',
        message:
          'Tanlangan xodim so‘rovni qabul qildi. Rahbar tasdig‘i kutilmoqda.',
        metadata: { scheduleChangeRequestId: request.id },
      },
    );
    await this.notifications?.sendWorkflowTelegram(
      hospitalId,
      [request.requestedById],
      'Tanlangan xodim so‘rovni qabul qildi. Endi rahbar tasdig‘i kutilmoqda.',
    );
    return updated;
  }

  async respondToChangeRequest(
    hospitalId: string,
    requestId: string,
    userId: string,
    accept: boolean,
  ) {
    if (accept) {
      return this.acceptChangeRequest(hospitalId, requestId, userId);
    }

    await this.requirePostCoverage(hospitalId);
    const request = await this.prisma.scheduleChangeRequest.findFirst({
      where: { id: requestId, hospitalId },
      include: {
        primaryEntry: true,
        replacementEmployee: { select: { userId: true } },
        counterpartEntry: {
          include: { employee: { select: { userId: true } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Smena o‘zgarishi topilmadi');
    if (request.status !== ScheduleChangeStatus.REQUESTED) {
      throw new BadRequestException('Bu so‘rovga javob berib bo‘lmaydi');
    }
    const expectedUserId =
      request.type === ScheduleChangeType.SWAP
        ? request.counterpartEntry?.employee?.userId
        : request.replacementEmployee?.userId;
    if (!expectedUserId || expectedUserId !== userId) {
      throw new BadRequestException(
        'Bu smena o‘zgarishiga faqat tanlangan xodim javob beradi',
      );
    }

    const updated = await this.prisma.scheduleChangeRequest.update({
      where: { id: request.id },
      data: {
        status: ScheduleChangeStatus.REJECTED,
        acceptedById: userId,
        acceptedAt: new Date(),
        decisionNote: 'Tanlangan xodim rad etdi',
      },
    });
    await this.notifications?.createForUsers([request.requestedById], {
      type: NotificationType.SYSTEM,
      title: 'Smena so‘rovi rad etildi',
      message: 'Tanlangan xodim smena o‘zgarishiga rozi bo‘lmadi.',
      metadata: { scheduleChangeRequestId: request.id },
    });
    await this.notifications?.sendWorkflowTelegram(
      hospitalId,
      [request.requestedById],
      'Tanlangan xodim smena o‘zgarishi so‘rovini rad etdi.',
    );
    return updated;
  }

  async cancelChangeRequest(
    hospitalId: string,
    requestId: string,
    userId: string,
  ) {
    await this.requirePostCoverage(hospitalId);
    const request = await this.prisma.scheduleChangeRequest.findFirst({
      where: { id: requestId, hospitalId },
      include: {
        replacementEmployee: { select: { userId: true } },
        counterpartEntry: {
          include: { employee: { select: { userId: true } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Smena o‘zgarishi topilmadi');
    if (request.requestedById !== userId) {
      throw new BadRequestException(
        'Faqat o‘zingiz yuborgan so‘rovni bekor qiling',
      );
    }
    if (
      !(
        [
          ScheduleChangeStatus.REQUESTED,
          ScheduleChangeStatus.ACCEPTED,
        ] as ScheduleChangeStatus[]
      ).includes(request.status)
    ) {
      throw new BadRequestException('Bu so‘rovni bekor qilib bo‘lmaydi');
    }

    const updated = await this.prisma.scheduleChangeRequest.update({
      where: { id: request.id },
      data: { status: ScheduleChangeStatus.CANCELLED },
    });
    const targetUserId =
      request.type === ScheduleChangeType.SWAP
        ? request.counterpartEntry?.employee?.userId
        : request.replacementEmployee?.userId;
    await this.notifications?.createForUsers(
      [targetUserId].filter((id): id is string => Boolean(id)),
      {
        type: NotificationType.SYSTEM,
        title: 'Smena so‘rovi bekor qilindi',
        message: 'So‘rov yuborgan xodim smena o‘zgarishini bekor qildi.',
        metadata: { scheduleChangeRequestId: request.id },
      },
    );
    return updated;
  }

  async approveChangeRequest(
    hospitalId: string,
    requestId: string,
    approvedById: string,
  ) {
    await this.requirePostCoverage(hospitalId);
    const request = await this.prisma.scheduleChangeRequest.findFirst({
      where: { id: requestId, hospitalId },
      include: {
        primaryEntry: true,
        counterpartEntry: {
          include: { employee: { select: { userId: true } } },
        },
        replacementEmployee: { select: { userId: true } },
        requestedBy: { select: { role: true } },
      },
    });
    if (!request) throw new NotFoundException('Smena o‘zgarishi topilmadi');
    this.assertChangeDateInWindow(request.primaryEntry.workDate);
    if (request.counterpartEntry) {
      this.assertChangeDateInWindow(request.counterpartEntry.workDate);
    }
    if (
      request.status !== ScheduleChangeStatus.REQUESTED &&
      request.status !== ScheduleChangeStatus.ACCEPTED
    ) {
      throw new BadRequestException(
        'So‘rov holati rahbar tasdig‘i uchun tayyor emas',
      );
    }
    if (
      request.requestedBy.role === UserRole.EMPLOYEE &&
      request.type !== ScheduleChangeType.ABSENCE &&
      request.status !== ScheduleChangeStatus.ACCEPTED
    ) {
      throw new BadRequestException(
        'Avval tanlangan xodim smena o‘zgarishini qabul qilishi kerak',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockPlanning(tx, hospitalId);
      // So'rov birinchi bo'lib "tasdiqlandi"ga o'tkaziladi: ikkinchi
      // (takroriy yoki parallel) tasdiqlash almashishni qayta qo'llab,
      // uni bekor qilib yubormaydi. Reja qayta ochilgan bo'lsa ham to'xtaydi.
      const claimed = await tx.scheduleChangeRequest.updateMany({
        where: {
          id: request.id,
          hospitalId,
          status: {
            in: [ScheduleChangeStatus.REQUESTED, ScheduleChangeStatus.ACCEPTED],
          },
          plan: { status: MonthlySchedulePlanStatus.APPROVED },
        },
        data: {
          status: ScheduleChangeStatus.APPROVED,
          approvedById,
          approvedAt: new Date(),
        },
      });
      if (!claimed.count) {
        throw new ConflictException(
          'So‘rov allaqachon ko‘rib chiqilgan yoki grafik qayta tahrirlashga ochilgan',
        );
      }
      if (request.type === ScheduleChangeType.SWAP) {
        if (!request.counterpartEntry) {
          throw new BadRequestException('Ikkinchi smena topilmadi');
        }
        await this.applySwap(tx, request);
      } else if (request.type === ScheduleChangeType.SUBSTITUTION) {
        if (!request.replacementEmployeeId) {
          throw new BadRequestException('O‘rnini bosadigan xodim topilmadi');
        }
        await this.applySubstitution(tx, request);
      } else {
        await this.markOriginalEmployeeAbsent(tx, request);
      }

      return tx.scheduleChangeRequest.findUnique({
        where: { id: request.id },
      });
    });
    await this.notifications?.createForUsers(
      [
        request.requestedById,
        request.replacementEmployee?.userId,
        request.counterpartEntry?.employee?.userId,
      ].filter((id): id is string => Boolean(id)),
      {
        type: NotificationType.SYSTEM,
        title: 'Smena o‘zgarishi tasdiqlandi',
        message:
          'Rahbar smena o‘zgarishini tasdiqladi. Amaldagi grafik yangilandi.',
        metadata: { scheduleChangeRequestId: request.id },
      },
    );
    await this.notifications?.sendWorkflowTelegram(
      hospitalId,
      [
        request.requestedById,
        request.replacementEmployee?.userId,
        request.counterpartEntry?.employee?.userId,
      ].filter((id): id is string => Boolean(id)),
      'Rahbar smena o‘zgarishini tasdiqladi. Amaldagi ish grafigi yangilandi.',
    );
    return updated;
  }

  async rejectChangeRequest(
    hospitalId: string,
    requestId: string,
    approvedById: string,
    reason: string,
  ) {
    await this.requirePostCoverage(hospitalId);
    const request = await this.prisma.scheduleChangeRequest.findFirst({
      where: { id: requestId, hospitalId },
      include: {
        replacementEmployee: { select: { userId: true } },
        counterpartEntry: {
          include: { employee: { select: { userId: true } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Smena o‘zgarishi topilmadi');
    if (
      !(
        [
          ScheduleChangeStatus.REQUESTED,
          ScheduleChangeStatus.ACCEPTED,
        ] as ScheduleChangeStatus[]
      ).includes(request.status)
    ) {
      throw new BadRequestException('Bu so‘rovni rad etib bo‘lmaydi');
    }
    const claimed = await this.prisma.scheduleChangeRequest.updateMany({
      where: {
        id: request.id,
        hospitalId,
        status: {
          in: [ScheduleChangeStatus.REQUESTED, ScheduleChangeStatus.ACCEPTED],
        },
      },
      data: {
        status: ScheduleChangeStatus.REJECTED,
        approvedById,
        approvedAt: new Date(),
        decisionNote: reason.trim(),
      },
    });
    if (!claimed.count) {
      throw new ConflictException('So‘rov allaqachon ko‘rib chiqilgan');
    }
    const updated = await this.prisma.scheduleChangeRequest.findUnique({
      where: { id: request.id },
    });
    await this.notifications?.createForUsers(
      [
        request.requestedById,
        request.replacementEmployee?.userId,
        request.counterpartEntry?.employee?.userId,
      ].filter((id): id is string => Boolean(id)),
      {
        type: NotificationType.SYSTEM,
        title: 'Smena o‘zgarishi rad etildi',
        message: `Rahbar so‘rovni rad etdi: ${reason.trim()}`,
        metadata: { scheduleChangeRequestId: request.id },
      },
    );
    await this.notifications?.sendWorkflowTelegram(
      hospitalId,
      [
        request.requestedById,
        request.replacementEmployee?.userId,
        request.counterpartEntry?.employee?.userId,
      ].filter((id): id is string => Boolean(id)),
      'Rahbar smena o‘zgarishi so‘rovini rad etdi. Tafsilotlarni StaffPlusPRO ilovasida ko‘ring.',
    );
    return updated;
  }

  private async getPlanForWorkflow(hospitalId: string, planId: string) {
    await this.requirePostCoverage(hospitalId);
    const plan = await this.prisma.monthlySchedulePlan.findFirst({
      where: { id: planId, hospitalId },
      include: { post: true, entries: true },
    });
    if (!plan) throw new NotFoundException('Oylik grafik topilmadi');
    const entries = await this.withCanonicalCarryIn(
      hospitalId,
      plan.postId,
      plan.year,
      plan.month,
      plan.entries,
    );
    return { ...plan, entries };
  }

  private async withCanonicalCarryIn(
    hospitalId: string,
    postId: string,
    year: number,
    month: number,
    entries: PlanEntryWithWorkDate[],
  ): Promise<
    Array<
      PlanEntryWithWorkDate & {
        isCarryIn?: boolean;
        isCanonicalCarryIn?: boolean;
      }
    >
  > {
    const monthStart = dayjs.tz(
      `${year}-${String(month).padStart(2, '0')}-01`,
      TZ,
    );
    const previousMonth = monthStart.subtract(1, 'month');
    const previousPlan = await this.prisma.monthlySchedulePlan.findFirst({
      where: {
        hospitalId,
        postId,
        year: previousMonth.year(),
        month: previousMonth.month() + 1,
        status: {
          in: [
            MonthlySchedulePlanStatus.DRAFT,
            MonthlySchedulePlanStatus.SUBMITTED,
            MonthlySchedulePlanStatus.APPROVED,
          ],
        },
      },
      orderBy: { version: 'desc' },
      include: {
        entries: {
          where: {
            entryType: SchedulePlanEntryType.WORKING,
            startsAt: { lt: monthStart.toDate() },
            endsAt: { gt: monthStart.toDate() },
          },
          include: {
            employee: { select: PLAN_EMPLOYEE_SELECT },
            shift: { select: PLAN_SHIFT_SELECT },
          },
        },
      },
    });
    const carryIn = (previousPlan?.entries ?? []).map((entry) => ({
      ...entry,
      isCarryIn: true as const,
      isCanonicalCarryIn: true as const,
    }));
    const monthStartDay = monthStart.format('YYYY-MM-DD');
    const isBeforeMonth = (workDate: Date) =>
      localDateParts(workDate).iso < monthStartDay;
    const currentMonthEntries = entries.filter(
      (entry) => !isBeforeMonth(entry.workDate),
    );

    if (carryIn.length) return [...carryIn, ...currentMonthEntries];

    return entries.map((entry) => ({
      ...entry,
      ...(isBeforeMonth(entry.workDate) && {
        isCarryIn: true,
      }),
    }));
  }

  private planCoveragePolicy(plan: {
    coverageMode?: SchedulePostCoverageMode | null;
    dailyCoverageMinutes?: number | null;
    coverageMinutesByWeekday?: unknown;
    post: {
      coverageMode?: SchedulePostCoverageMode | null;
      dailyCoverageMinutes: number;
      coverageMinutesByWeekday?: unknown;
    };
  }): PostCoveragePolicy {
    return normalizePostCoveragePolicy({
      coverageMode: plan.coverageMode ?? plan.post.coverageMode,
      dailyCoverageMinutes:
        plan.dailyCoverageMinutes ?? plan.post.dailyCoverageMinutes,
      coverageMinutesByWeekday:
        plan.coverageMinutesByWeekday ?? plan.post.coverageMinutesByWeekday,
    });
  }

  private buildPlanSummary(plan: {
    year: number;
    month: number;
    coverageMode?: SchedulePostCoverageMode | null;
    dailyCoverageMinutes?: number | null;
    coverageMinutesByWeekday?: unknown;
    post: {
      coverageMode?: SchedulePostCoverageMode | null;
      dailyCoverageMinutes: number;
      coverageMinutesByWeekday?: unknown;
    };
    entries: Array<{
      employeeId: string;
      entryType: SchedulePlanEntryType;
      startsAt: Date | null;
      endsAt: Date | null;
      countsTowardPostCoverage?: boolean;
      isCarryIn?: boolean;
      shift?: { type?: string | null } | null;
    }>;
  }) {
    const coverageTargets = calculateMonthlyCoverageTargets(
      plan.year,
      plan.month,
      this.planCoveragePolicy(plan),
    );
    const coverage = calculateCoverageSummary(
      plan.entries.filter((entry) => entry.countsTowardPostCoverage !== false),
      plan.year,
      plan.month,
      coverageTargets.targetMinutes,
    );
    // Bitta post normasi (744/720 soat). Xodimlar ko'p bo'lsa reja bir
    // necha postga teng bo'ladi; maqsad — eng yaqin to'liq postlar soni.
    const postNorm = calculatePostNormBreakdown(
      coverage.plannedMinutes,
      coverageTargets.targetMinutes,
    );
    const slots = Math.max(1, postNorm.postSlots);
    const targetMinutes = coverageTargets.targetMinutes * slots;
    const daysInMonth = new Date(
      Date.UTC(plan.year, plan.month, 0),
    ).getUTCDate();
    const days = Array.from({ length: daysInMonth }, (_, index) => {
      const date = `${plan.year}-${String(plan.month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
      return {
        date,
        plannedMinutes: coverage.byDate[date] ?? 0,
        targetMinutes: (coverageTargets.byDate[date] ?? 0) * slots,
      };
    });
    return {
      ...coverage,
      targetMinutes,
      remainingMinutes: Math.max(0, targetMinutes - coverage.plannedMinutes),
      excessMinutes: Math.max(0, coverage.plannedMinutes - targetMinutes),
      ...postNorm,
      employeeStats: calculateEmployeeShiftStats(
        plan.entries,
        plan.year,
        plan.month,
      ),
      postCoverageRequired: this.requiresPostCoverageNorm(plan.entries),
      days,
    };
  }

  /**
   * Post normasi (masalan 720/744 soat) faqat rejada shu oyning post
   * xodimi bo'lsa talab qilinadi. Faqat postdan tashqari xodimlar
   * grafigi (countsTowardPostCoverage=false) normaga tekshirilmaydi;
   * oldingi oydan o'tgan tungi smena (carry-in) hisobga olinmaydi.
   */
  private requiresPostCoverageNorm(
    entries: Array<{ countsTowardPostCoverage?: boolean; isCarryIn?: boolean }>,
  ): boolean {
    return entries.some(
      (entry) => !entry.isCarryIn && entry.countsTowardPostCoverage !== false,
    );
  }

  private assertPlanReadyForReview(
    plan: Parameters<SchedulePlanningService['buildPlanSummary']>[0],
  ) {
    const ownEntries = plan.entries.filter((entry) => !entry.isCarryIn);
    if (!ownEntries.length) {
      throw new BadRequestException('Grafikda birorta ham katak yo‘q');
    }
    const summary = this.buildPlanSummary(plan);
    if (!summary.postCoverageRequired) return;
    if (summary.remainingMinutes || summary.excessMinutes) {
      throw new BadRequestException(this.postNormGapMessage(summary));
    }
  }

  /**
   * Foydalanuvchiga nima qilish kerakligini aniq aytadi. Ortib qolgan
   * soatlarni dastur o'zi «postdan tashqari» qilmaydi — qaror foydalanuvchida.
   */
  private postNormGapMessage(summary: {
    plannedMinutes: number;
    targetMinutes: number;
    postNormMinutes: number;
    fullPostCount: number;
    remainderMinutes: number;
    missingMinutes: number;
    postSlots: number;
  }) {
    const hours = (minutes: number) => Number((minutes / 60).toFixed(2));
    const norm = hours(summary.postNormMinutes);
    const head = `Postning oylik normasi to‘liq taqsimlanmagan: ${hours(summary.plannedMinutes)}/${hours(summary.targetMinutes)} soat`;
    if (!summary.fullPostCount) {
      return `${head}. Bitta post ${norm} soat — yana ${hours(summary.missingMinutes)} soat rejalashtiring.`;
    }
    return (
      `${head} (${summary.postSlots} post × ${norm} soat). ` +
      `${summary.fullPostCount} ta post to‘liq (${hours(summary.fullPostCount * summary.postNormMinutes)} soat), ` +
      `${hours(summary.remainderMinutes)} soat ortib qoldi. ` +
      `Oxirgi postni ${norm} soatga to‘ldiring (yana ${hours(summary.missingMinutes)} soat) ` +
      `yoki ortiqcha xodimni «Postdan tashqari» deb belgilang.`
    );
  }

  private mapEntryTypeToScheduleStatus(
    entryType: SchedulePlanEntryType,
  ): ScheduleStatus {
    const map: Record<SchedulePlanEntryType, ScheduleStatus> = {
      WORKING: ScheduleStatus.WORKING,
      DAY_OFF: ScheduleStatus.DAY_OFF,
      SICK: ScheduleStatus.SICK,
      VACATION: ScheduleStatus.VACATION,
      MATERNITY_LEAVE: ScheduleStatus.MATERNITY_LEAVE,
      TRAINING: ScheduleStatus.TRAINING,
      OTHER_ABSENCE: ScheduleStatus.OTHER_ABSENCE,
    };
    return map[entryType];
  }

  private approvedChangesForExcel(plan: any) {
    const typeLabels: Record<ScheduleChangeType, string> = {
      SWAP: 'Smena almashish',
      SUBSTITUTION: 'O‘rniga chiqish',
      ABSENCE: 'Ishga chiqmaslik',
    };
    const absenceLabels: Record<SchedulePlanEntryType, string> = {
      WORKING: 'Ish',
      DAY_OFF: 'Dam olish',
      SICK: 'Kasallik',
      VACATION: 'Mehnat ta‘tili',
      MATERNITY_LEAVE: 'Tug‘ruq ta‘tili',
      TRAINING: 'Malaka oshirish',
      OTHER_ABSENCE: 'Boshqa sabab',
    };
    const date = (value: Date) => dayjs(value).tz(TZ).format('DD.MM.YYYY');
    const dateTime = (value?: Date | null) =>
      value ? dayjs(value).tz(TZ).format('DD.MM.YYYY HH:mm') : '';

    return ((plan.changeRequests ?? []) as any[])
      .filter(
        (request) =>
          request.status === ScheduleChangeStatus.APPROVED &&
          request.primaryEntry,
      )
      .sort(
        (a, b) =>
          new Date(a.approvedAt ?? a.createdAt).getTime() -
          new Date(b.approvedAt ?? b.createdAt).getTime(),
      )
      .map((request) => {
        const primary = request.primaryEntry;
        const counterpart = request.counterpartEntry;
        const absence =
          absenceLabels[
            (request.absenceEntryType as SchedulePlanEntryType) ??
              SchedulePlanEntryType.DAY_OFF
          ];
        const fromName = primary.employee?.fullName ?? '';
        let toName = '';
        let description: string;
        const targets: Array<{ employeeId: string; workDate: Date }> = [
          { employeeId: primary.employeeId, workDate: primary.workDate },
        ];
        if (request.type === ScheduleChangeType.SWAP && counterpart) {
          toName = counterpart.employee?.fullName ?? '';
          description = `${fromName} (${date(primary.workDate)}) ↔ ${toName} (${date(counterpart.workDate)})`;
          targets.push(
            {
              employeeId: counterpart.employeeId,
              workDate: counterpart.workDate,
            },
            { employeeId: counterpart.employeeId, workDate: primary.workDate },
            { employeeId: primary.employeeId, workDate: counterpart.workDate },
          );
        } else if (request.type === ScheduleChangeType.SUBSTITUTION) {
          toName = request.replacementEmployee?.fullName ?? '';
          description = `${fromName} o‘rniga ${toName}, ${date(primary.workDate)} (${absence})`;
          if (request.replacementEmployeeId) {
            targets.push({
              employeeId: request.replacementEmployeeId,
              workDate: primary.workDate,
            });
          }
        } else {
          description = `${fromName} ${date(primary.workDate)} ishga chiqmaydi (${absence})`;
        }
        return {
          typeLabel: typeLabels[request.type as ScheduleChangeType],
          shiftDateText:
            request.type === ScheduleChangeType.SWAP && counterpart
              ? `${date(primary.workDate)} ↔ ${date(counterpart.workDate)}`
              : date(primary.workDate),
          fromName,
          toName,
          absenceLabel: request.type === ScheduleChangeType.SWAP ? '' : absence,
          reason: request.reason ?? '',
          requestedBy: request.requestedBy?.username ?? '',
          requestedAtText: dateTime(request.createdAt),
          approvedBy: request.approvedBy?.username ?? '',
          approvedAtText: dateTime(request.approvedAt),
          description,
          targets,
        };
      });
  }

  private addChangesSheet(
    workbook: ExcelJS.Workbook,
    plan: any,
    changes: ReturnType<SchedulePlanningService['approvedChangesForExcel']>,
  ) {
    const sheet = workbook.addWorksheet('O‘zgarishlar', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
      views: [{ state: 'frozen', ySplit: 2 }],
    });
    const columns = [
      { header: '№', width: 5 },
      { header: 'Smena sanasi', width: 22 },
      { header: 'Turi', width: 17 },
      { header: 'Asl xodim', width: 26 },
      { header: 'Yangi xodim', width: 26 },
      { header: 'Sabab turi', width: 16 },
      { header: 'Izoh', width: 32 },
      { header: 'So‘radi', width: 14 },
      { header: 'So‘ralgan sana', width: 17 },
      { header: 'Tasdiqladi', width: 14 },
      { header: 'Tasdiqlangan sana', width: 17 },
    ];
    sheet.mergeCells(1, 1, 1, columns.length);
    sheet.getCell(1, 1).value =
      `${plan.post.name} — ${plan.year}-yil ${plan.month}-oy: tasdiqdan keyingi o‘zgarishlar`;
    sheet.getCell(1, 1).font = { name: 'Arial', size: 12, bold: true };
    sheet.getRow(1).height = 22;

    const header = sheet.getRow(2);
    columns.forEach((column, i) => {
      header.getCell(i + 1).value = column.header;
      sheet.getColumn(i + 1).width = column.width;
    });
    header.height = 24;

    changes.forEach((change, i) => {
      sheet.getRow(i + 3).values = [
        i + 1,
        change.shiftDateText,
        change.typeLabel,
        change.fromName,
        change.toName,
        change.absenceLabel,
        change.reason,
        change.requestedBy,
        change.requestedAtText,
        change.approvedBy,
        change.approvedAtText,
      ];
    });
    if (!changes.length) {
      sheet.mergeCells(3, 1, 3, columns.length);
      sheet.getCell(3, 1).value = 'Tasdiqdan keyin o‘zgarish kiritilmagan.';
    }

    const lastRow = Math.max(3, changes.length + 2);
    for (let row = 2; row <= lastRow; row += 1) {
      for (let column = 1; column <= columns.length; column += 1) {
        const cell = sheet.getCell(row, column);
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
        cell.alignment = {
          vertical: 'middle',
          horizontal: column === 1 ? 'center' : 'left',
          wrapText: true,
        };
        cell.font = { name: 'Arial', size: 9, bold: row === 2 };
      }
    }
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
  }

  private entryTypeExcelCode(entryType: SchedulePlanEntryType): string {
    const codes: Record<SchedulePlanEntryType, string> = {
      WORKING: '',
      DAY_OFF: 'D',
      SICK: 'K',
      VACATION: 'MT',
      MATERNITY_LEAVE: 'TT',
      TRAINING: 'MO',
      OTHER_ABSENCE: 'B',
    };
    return codes[entryType];
  }

  private async markOriginalEmployeeAbsent(
    tx: Prisma.TransactionClient,
    request: {
      id: string;
      planId: string;
      absenceEntryType: SchedulePlanEntryType | null;
      primaryEntry: {
        id: string;
        employeeId: string;
        workDate: Date;
      };
    },
  ) {
    const absenceType =
      request.absenceEntryType ?? SchedulePlanEntryType.DAY_OFF;
    await tx.schedule.upsert({
      where: {
        employeeId_date: {
          employeeId: request.primaryEntry.employeeId,
          date: request.primaryEntry.workDate,
        },
      },
      create: {
        employeeId: request.primaryEntry.employeeId,
        date: request.primaryEntry.workDate,
        status: this.mapEntryTypeToScheduleStatus(absenceType),
        sourcePlanId: request.planId,
        sourceEntryId: request.primaryEntry.id,
        scheduleChangeRequestId: request.id,
      },
      update: {
        shiftId: null,
        status: this.mapEntryTypeToScheduleStatus(absenceType),
        scheduleChangeRequestId: request.id,
      },
    });
  }

  /**
   * Bo'sh smena birjasi (post rejali muassasa): xodimning shu kungi
   * tasdiqlangan post rejadagi ish smenasi.
   */
  async findApprovedWorkingEntry(
    hospitalId: string,
    employeeId: string,
    workDate: Date,
  ) {
    return this.prisma.monthlyScheduleEntry.findFirst({
      where: {
        employeeId,
        workDate,
        entryType: SchedulePlanEntryType.WORKING,
        plan: { hospitalId, status: MonthlySchedulePlanStatus.APPROVED },
      },
      include: {
        shift: {
          select: {
            id: true,
            name: true,
            startTime: true,
            endTime: true,
            isOvernight: true,
          },
        },
      },
      orderBy: { plan: { version: 'desc' } },
    });
  }

  /**
   * Bo'sh smena birjasidan tasdiqlangan almashtirish.
   *
   * Post reja hujjat sifatida o'zgarmaydi: tasdiqlangan "o'rnini bosish"
   * (SUBSTITUTION) yozuvi yaratiladi va amaldagi grafik yangilanadi —
   * Excel'dagi "O'zgarishlar" varag'ida ham ko'rinadi. Kelmagan xodimning
   * kuni "Boshqa yo'qlik" bo'ladi; u allaqachon kasallik/ta'til va hokazo
   * deb belgilangan bo'lsa, o'sha holat saqlanadi.
   */
  async substituteFromOpenShift(
    tx: Prisma.TransactionClient,
    params: {
      hospitalId: string;
      entryId: string;
      replacementEmployeeId: string;
      requestedById: string;
      approvedById: string | null;
      reason: string;
    },
  ) {
    await this.lockPlanning(tx, params.hospitalId);
    const entry = await tx.monthlyScheduleEntry.findFirst({
      where: {
        id: params.entryId,
        entryType: SchedulePlanEntryType.WORKING,
        plan: {
          hospitalId: params.hospitalId,
          status: MonthlySchedulePlanStatus.APPROVED,
        },
      },
    });
    if (!entry) {
      throw new ConflictException(
        'Post rejadagi smena o‘zgargan yoki reja qayta tahrirlashga ochilgan',
      );
    }
    this.assertChangeDateInWindow(entry.workDate);

    const blocking = await tx.scheduleChangeRequest.findFirst({
      where: {
        hospitalId: params.hospitalId,
        OR: [{ primaryEntryId: entry.id }, { counterpartEntryId: entry.id }],
        AND: [
          {
            OR: [
              {
                status: {
                  in: [
                    ScheduleChangeStatus.REQUESTED,
                    ScheduleChangeStatus.ACCEPTED,
                  ],
                },
              },
              {
                status: ScheduleChangeStatus.APPROVED,
                type: {
                  in: [
                    ScheduleChangeType.SUBSTITUTION,
                    ScheduleChangeType.SWAP,
                  ],
                },
              },
            ],
          },
        ],
      },
      select: { status: true },
    });
    if (blocking) {
      throw new ConflictException(
        blocking.status === ScheduleChangeStatus.APPROVED
          ? 'Bu smena allaqachon boshqa xodimga o‘tkazilgan'
          : 'Bu smena uchun yakunlanmagan o‘zgarish so‘rovi mavjud',
      );
    }

    const original = await tx.schedule.findUnique({
      where: {
        employeeId_date: {
          employeeId: entry.employeeId,
          date: entry.workDate,
        },
      },
      select: { status: true },
    });

    const request = await tx.scheduleChangeRequest.create({
      data: {
        hospitalId: params.hospitalId,
        planId: entry.planId,
        type: ScheduleChangeType.SUBSTITUTION,
        status: ScheduleChangeStatus.APPROVED,
        primaryEntryId: entry.id,
        replacementEmployeeId: params.replacementEmployeeId,
        absenceEntryType: SchedulePlanEntryType.OTHER_ABSENCE,
        reason: params.reason,
        requestedById: params.requestedById,
        approvedById: params.approvedById,
        approvedAt: new Date(),
      },
    });
    await this.applySubstitution(
      tx,
      {
        id: request.id,
        planId: entry.planId,
        replacementEmployeeId: params.replacementEmployeeId,
        absenceEntryType: SchedulePlanEntryType.OTHER_ABSENCE,
        primaryEntry: {
          id: entry.id,
          employeeId: entry.employeeId,
          shiftId: entry.shiftId,
          workDate: entry.workDate,
        },
      },
      { markOriginal: !original || original.status === ScheduleStatus.WORKING },
    );
    return request;
  }

  private async applySubstitution(
    tx: Prisma.TransactionClient,
    request: {
      id: string;
      planId: string;
      replacementEmployeeId: string;
      absenceEntryType: SchedulePlanEntryType | null;
      primaryEntry: {
        id: string;
        employeeId: string;
        shiftId: string | null;
        workDate: Date;
      };
    },
    options: { markOriginal?: boolean } = {},
  ) {
    const occupied = await tx.schedule.findUnique({
      where: {
        employeeId_date: {
          employeeId: request.replacementEmployeeId,
          date: request.primaryEntry.workDate,
        },
      },
      select: { id: true, status: true },
    });
    if (occupied?.status === ScheduleStatus.WORKING) {
      throw new ConflictException(
        'O‘rnini bosadigan xodimda shu kuni boshqa smena mavjud',
      );
    }
    if (options.markOriginal !== false) {
      await this.markOriginalEmployeeAbsent(tx, request);
    }
    await tx.schedule.upsert({
      where: {
        employeeId_date: {
          employeeId: request.replacementEmployeeId,
          date: request.primaryEntry.workDate,
        },
      },
      create: {
        employeeId: request.replacementEmployeeId,
        shiftId: request.primaryEntry.shiftId,
        date: request.primaryEntry.workDate,
        status: ScheduleStatus.WORKING,
        sourcePlanId: request.planId,
        sourceEntryId: request.primaryEntry.id,
        scheduleChangeRequestId: request.id,
      },
      update: {
        shiftId: request.primaryEntry.shiftId,
        status: ScheduleStatus.WORKING,
        sourcePlanId: request.planId,
        sourceEntryId: request.primaryEntry.id,
        scheduleChangeRequestId: request.id,
      },
    });
  }

  private async applySwap(
    tx: Prisma.TransactionClient,
    request: {
      id: string;
      planId: string;
      primaryEntry: {
        id: string;
        employeeId: string;
        shiftId: string | null;
        workDate: Date;
      };
      counterpartEntry: {
        id: string;
        planId: string;
        employeeId: string;
        shiftId: string | null;
        workDate: Date;
      };
    },
  ) {
    const primary = request.primaryEntry;
    const counterpart = request.counterpartEntry;
    if (primary.workDate.getTime() === counterpart.workDate.getTime()) {
      await tx.schedule.update({
        where: {
          employeeId_date: {
            employeeId: primary.employeeId,
            date: primary.workDate,
          },
        },
        data: {
          shiftId: counterpart.shiftId,
          scheduleChangeRequestId: request.id,
        },
      });
      await tx.schedule.update({
        where: {
          employeeId_date: {
            employeeId: counterpart.employeeId,
            date: counterpart.workDate,
          },
        },
        data: {
          shiftId: primary.shiftId,
          scheduleChangeRequestId: request.id,
        },
      });
      return;
    }

    const [primaryAtCounterpartDate, counterpartAtPrimaryDate] =
      await Promise.all([
        tx.schedule.findUnique({
          where: {
            employeeId_date: {
              employeeId: primary.employeeId,
              date: counterpart.workDate,
            },
          },
          select: { status: true },
        }),
        tx.schedule.findUnique({
          where: {
            employeeId_date: {
              employeeId: counterpart.employeeId,
              date: primary.workDate,
            },
          },
          select: { status: true },
        }),
      ]);
    if (
      primaryAtCounterpartDate?.status === ScheduleStatus.WORKING ||
      counterpartAtPrimaryDate?.status === ScheduleStatus.WORKING
    ) {
      throw new ConflictException(
        'Xodimlardan birida almashiladigan kunda boshqa ish smenasi mavjud',
      );
    }

    await tx.schedule.update({
      where: {
        employeeId_date: {
          employeeId: primary.employeeId,
          date: primary.workDate,
        },
      },
      data: {
        shiftId: null,
        status: ScheduleStatus.DAY_OFF,
        scheduleChangeRequestId: request.id,
      },
    });
    await tx.schedule.update({
      where: {
        employeeId_date: {
          employeeId: counterpart.employeeId,
          date: counterpart.workDate,
        },
      },
      data: {
        shiftId: null,
        status: ScheduleStatus.DAY_OFF,
        scheduleChangeRequestId: request.id,
      },
    });
    await tx.schedule.upsert({
      where: {
        employeeId_date: {
          employeeId: counterpart.employeeId,
          date: primary.workDate,
        },
      },
      create: {
        employeeId: counterpart.employeeId,
        shiftId: primary.shiftId,
        date: primary.workDate,
        status: ScheduleStatus.WORKING,
        sourcePlanId: request.planId,
        sourceEntryId: primary.id,
        scheduleChangeRequestId: request.id,
      },
      update: {
        shiftId: primary.shiftId,
        status: ScheduleStatus.WORKING,
        sourcePlanId: request.planId,
        sourceEntryId: primary.id,
        scheduleChangeRequestId: request.id,
      },
    });
    await tx.schedule.upsert({
      where: {
        employeeId_date: {
          employeeId: primary.employeeId,
          date: counterpart.workDate,
        },
      },
      create: {
        employeeId: primary.employeeId,
        shiftId: counterpart.shiftId,
        date: counterpart.workDate,
        status: ScheduleStatus.WORKING,
        sourcePlanId: counterpart.planId,
        sourceEntryId: counterpart.id,
        scheduleChangeRequestId: request.id,
      },
      update: {
        shiftId: counterpart.shiftId,
        status: ScheduleStatus.WORKING,
        sourcePlanId: counterpart.planId,
        sourceEntryId: counterpart.id,
        scheduleChangeRequestId: request.id,
      },
    });
  }

  private async requirePostCoverage(hospitalId: string) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { schedulePlanningMode: true },
    });
    if (!hospital) throw new NotFoundException('Muassasa topilmadi');
    if (hospital.schedulePlanningMode !== SchedulePlanningMode.POST_COVERAGE) {
      throw new BadRequestException(
        'Bu muassasada post bo‘yicha grafik rejimi yoqilmagan',
      );
    }
  }
}
