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
  ScheduleStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSchedulePostDto } from './dto/create-schedule-post.dto';
import { CreateMonthlySchedulePlanDto } from './dto/create-monthly-schedule-plan.dto';
import { SaveSchedulePlanEntriesDto } from './dto/save-schedule-plan-entries.dto';
import { CreateScheduleChangeDto } from './dto/create-schedule-change.dto';
import {
  assertNoEmployeeOverlaps,
  calculateCoverageSummary,
  splitIntervalByCalendarDate,
} from './schedule-planning-calculator';
import { DateUtil } from '../common/utils/date.util';
import { NotificationsService } from '../notifications/notifications.service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import * as ExcelJS from 'exceljs';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

export function calculateMonthlyCoverageMinutes(
  year: number,
  month: number,
  dailyCoverageMinutes: number,
): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return daysInMonth * dailyCoverageMinutes;
}

@Injectable()
export class SchedulePlanningService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

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

    return this.prisma.schedulePost.create({
      data: {
        hospitalId,
        departmentId: dto.departmentId,
        name: dto.name.trim(),
        code,
        dailyCoverageMinutes: dto.dailyCoverageMinutes ?? 1440,
      },
      include: { department: true },
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
      select: { id: true, dailyCoverageMinutes: true },
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
      },
      include: { post: { include: { department: true } } },
    });

    const targetMinutes = calculateMonthlyCoverageMinutes(
      dto.year,
      dto.month,
      post.dailyCoverageMinutes,
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
            employee: { include: { department: true, position: true } },
            shift: true,
          },
          orderBy: [{ employee: { fullName: 'asc' } }, { workDate: 'asc' }],
        },
        changeRequests: {
          include: {
            primaryEntry: { include: { employee: true, shift: true } },
            counterpartEntry: { include: { employee: true, shift: true } },
            replacementEmployee: true,
            requestedBy: { select: { id: true, username: true } },
            acceptedBy: { select: { id: true, username: true } },
            approvedBy: { select: { id: true, username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!plan) throw new NotFoundException('Oylik grafik topilmadi');

    const summary = this.buildPlanSummary(plan);
    return {
      ...plan,
      entries: plan.entries.map((entry) => ({
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
      })),
      summary,
    };
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
    const daysInMonth = new Date(
      Date.UTC(plan.year, plan.month, 0),
    ).getUTCDate();
    const totalColumn = 4 + daysInMonth;

    worksheet.mergeCells(1, 1, 1, totalColumn);
    worksheet.getCell(1, 1).value = plan.hospital?.name ?? 'Muassasa';
    worksheet.mergeCells(2, 1, 2, totalColumn);
    worksheet.getCell(2, 1).value =
      `${plan.post.department.name} — ${plan.year}-yil ${plan.month}-oy uchun`;
    worksheet.mergeCells(3, 1, 3, totalColumn);
    worksheet.getCell(3, 1).value = `ISH JADVALI — ${plan.post.name}`;
    worksheet.mergeCells(4, 1, 4, totalColumn);
    worksheet.getCell(4, 1).value =
      `Holat: ${plan.status} | Versiya: ${plan.version} | Post normasi: ${plan.summary.targetMinutes / 60} soat`;

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
    headerRow.getCell(totalColumn).value = 'Jami';
    headerRow.height = 26;

    const employeeRows = new Map<
      string,
      {
        employee: any;
        values: Map<number, number | string>;
        totalMinutes: number;
      }
    >();
    for (const entry of plan.entries) {
      let employeeRow = employeeRows.get(entry.employeeId);
      if (!employeeRow) {
        employeeRow = {
          employee: entry.employee,
          values: new Map(),
          totalMinutes: 0,
        };
        employeeRows.set(entry.employeeId, employeeRow);
      }
      if (entry.entryType === SchedulePlanEntryType.WORKING) {
        for (const [date, minutes] of Object.entries(
          entry.calendarMinutes as Record<string, number>,
        )) {
          const day = Number(date.slice(-2));
          const current = employeeRow.values.get(day);
          const currentMinutes = typeof current === 'number' ? current * 60 : 0;
          employeeRow.values.set(day, (currentMinutes + minutes) / 60);
          employeeRow.totalMinutes += minutes;
        }
      } else {
        const localDate = dayjs(entry.workDate).tz(TZ);
        if (
          localDate.year() === plan.year &&
          localDate.month() + 1 === plan.month
        ) {
          employeeRow.values.set(
            localDate.date(),
            this.entryTypeExcelCode(entry.entryType),
          );
        }
      }
    }

    let rowNumber = 6;
    let index = 1;
    for (const item of employeeRows.values()) {
      const row = worksheet.getRow(rowNumber);
      row.getCell(1).value = index;
      row.getCell(2).value = item.employee.fullName;
      row.getCell(3).value = item.employee.position?.name ?? '';
      for (let day = 1; day <= daysInMonth; day += 1) {
        row.getCell(day + 3).value = item.values.get(day) ?? '';
      }
      row.getCell(totalColumn).value = item.totalMinutes / 60;
      row.height = 21;
      rowNumber += 1;
      index += 1;
    }

    const postTotalRow = worksheet.getRow(rowNumber + 1);
    postTotalRow.getCell(1).value = 'POST JAMI';
    worksheet.mergeCells(rowNumber + 1, 1, rowNumber + 1, 3);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${plan.year}-${String(plan.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      postTotalRow.getCell(day + 3).value =
        (plan.summary.byDate[date] ?? 0) / 60;
    }
    postTotalRow.getCell(totalColumn).value = plan.summary.plannedMinutes / 60;

    const targetRow = worksheet.getRow(rowNumber + 2);
    targetRow.getCell(1).value = 'POST NORMASI';
    worksheet.mergeCells(rowNumber + 2, 1, rowNumber + 2, totalColumn - 1);
    targetRow.getCell(totalColumn).value = plan.summary.targetMinutes / 60;

    const approvalRow = worksheet.getRow(rowNumber + 4);
    approvalRow.getCell(1).value = 'Bo‘lim mudiri:';
    approvalRow.getCell(Math.max(5, totalColumn - 8)).value = 'Tasdiqlayman:';
    const approvalInfoRow = worksheet.getRow(rowNumber + 5);
    approvalInfoRow.getCell(Math.max(5, totalColumn - 8)).value =
      plan.approvedBy?.username ?? '';
    approvalInfoRow.getCell(Math.max(5, totalColumn - 3)).value =
      plan.approvedAt
        ? dayjs(plan.approvedAt).tz(TZ).format('DD.MM.YYYY HH:mm')
        : '';

    worksheet.getColumn(1).width = 5;
    worksheet.getColumn(2).width = 28;
    worksheet.getColumn(3).width = 18;
    for (let day = 1; day <= daysInMonth; day += 1) {
      worksheet.getColumn(day + 3).width = 4;
    }
    worksheet.getColumn(totalColumn).width = 8;

    const border: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } },
    };
    for (let row = 5; row <= rowNumber + 2; row += 1) {
      for (let column = 1; column <= totalColumn; column += 1) {
        const cell = worksheet.getCell(row, column);
        cell.border = border;
        cell.alignment = {
          horizontal: column === 2 || column === 3 ? 'left' : 'center',
          vertical: 'middle',
          wrapText: true,
        };
        cell.font = { name: 'Arial', size: 9, bold: row === 5 };
      }
    }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = dayjs.tz(
        `${plan.year}-${String(plan.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        TZ,
      );
      if ([0, 6].includes(date.day())) {
        for (let row = 5; row <= rowNumber + 1; row += 1) {
          worksheet.getCell(row, day + 3).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE7E6E6' },
          };
        }
      }
    }
    postTotalRow.font = { name: 'Arial', size: 9, bold: true };
    targetRow.font = { name: 'Arial', size: 9, bold: true };
    worksheet.autoFilter = {
      from: { row: 5, column: 1 },
      to: { row: Math.max(5, rowNumber - 1), column: totalColumn },
    };
    worksheet.pageSetup.printTitlesRow = '1:5';
    worksheet.pageSetup.printArea = `A1:${worksheet.getColumn(totalColumn).letter}${rowNumber + 5}`;

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
    const normalized = dto.entries.map((entry) => {
      const workDate = DateUtil.startOfDay(entry.workDate);
      const workDay = dayjs(workDate).tz(TZ);
      if (
        workDay.isBefore(monthStart.subtract(1, 'day'), 'day') ||
        !workDay.isBefore(monthEnd, 'day')
      ) {
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
        if (
          dayjs(startsAt).tz(TZ).format('YYYY-MM-DD') !==
          workDay.format('YYYY-MM-DD')
        ) {
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
        workDate,
        startsAt: null,
        endsAt: null,
        note: entry.note?.trim() || null,
      };
    });

    const uniqueDayKeys = new Set<string>();
    for (const entry of normalized) {
      const key = `${entry.employeeId}:${dayjs(entry.workDate).tz(TZ).format('YYYY-MM-DD')}`;
      if (uniqueDayKeys.has(key)) {
        throw new BadRequestException(
          'Bir xodimga bir kunda bittadan ortiq grafik katagi berilmaydi',
        );
      }
      uniqueDayKeys.add(key);
    }
    assertNoEmployeeOverlaps(normalized);

    const otherEntries = employeeIds.length
      ? await this.prisma.monthlyScheduleEntry.findMany({
          where: {
            hospitalId,
            planId: { not: planId },
            employeeId: { in: employeeIds },
            workDate: {
              // Oldingi oy rejasidagi oxirgi tun smenasi joriy oyda
              // 00:00-08:00 sifatida carry-in qilinadi. Joriy reja shu
              // katakni takrorlashi kerak, ammo approve paytida u qayta
              // publish qilinmaydi. Shu sababli boshqa rejalarning faqat
              // joriy oy ichidagi kunlari collision tekshiruviga kiradi.
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
          `${entry.employeeId}:${dayjs(entry.workDate).tz(TZ).format('YYYY-MM-DD')}`,
      ),
    );
    if ([...uniqueDayKeys].some((key) => otherDayKeys.has(key))) {
      throw new BadRequestException(
        'Xodimga boshqa post grafigida shu kun uchun smena biriktirilgan',
      );
    }
    assertNoEmployeeOverlaps([...normalized, ...otherEntries]);

    const summary = calculateCoverageSummary(
      normalized,
      plan.year,
      plan.month,
      calculateMonthlyCoverageMinutes(
        plan.year,
        plan.month,
        plan.post.dailyCoverageMinutes,
      ),
    );
    const overfilledDay = Object.entries(summary.byDate).find(
      ([, minutes]) => minutes > plan.post.dailyCoverageMinutes,
    );
    if (overfilledDay || summary.excessMinutes > 0) {
      throw new BadRequestException(
        `Post soati limitdan oshgan${overfilledDay ? `: ${overfilledDay[0]}` : ''}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.monthlyScheduleEntry.deleteMany({ where: { planId } });
      if (normalized.length) {
        await tx.monthlyScheduleEntry.createMany({ data: normalized });
      }
    });
    return this.getPlanDetails(hospitalId, planId);
  }

  async submitPlan(hospitalId: string, planId: string) {
    const plan = await this.getPlanForWorkflow(hospitalId, planId);
    if (plan.status !== MonthlySchedulePlanStatus.DRAFT) {
      throw new BadRequestException('Faqat qoralama grafik yuboriladi');
    }
    const summary = this.buildPlanSummary(plan);
    const incompleteDay = summary.days.find(
      (day) => day.plannedMinutes !== day.targetMinutes,
    );
    if (incompleteDay) {
      throw new BadRequestException(
        `${incompleteDay.date} kuni post qamrovi ${incompleteDay.plannedMinutes / 60}/${incompleteDay.targetMinutes / 60} soat`,
      );
    }
    return this.prisma.monthlySchedulePlan.update({
      where: { id: planId },
      data: {
        status: MonthlySchedulePlanStatus.SUBMITTED,
        submittedAt: new Date(),
        decisionNote: null,
      },
    });
  }

  async approvePlan(hospitalId: string, planId: string, approvedById: string) {
    const plan = await this.getPlanForWorkflow(hospitalId, planId);
    if (plan.status !== MonthlySchedulePlanStatus.SUBMITTED) {
      throw new BadRequestException(
        'Faqat tasdiqlashga yuborilgan grafik tasdiqlanadi',
      );
    }
    const summary = this.buildPlanSummary(plan);
    if (summary.remainingMinutes || summary.excessMinutes) {
      throw new BadRequestException('Postning oylik qamrovi to‘liq emas');
    }

    return this.prisma.$transaction(async (tx) => {
      for (const entry of plan.entries) {
        // Oldingi oyning oxirida boshlangan carry-in smena o'sha oy grafigi
        // tomonidan nashr qilinadi; bu oy faqat Excel/qamrovda uning qismini oladi.
        const workDay = dayjs(entry.workDate).tz(TZ);
        if (
          workDay.year() !== plan.year ||
          workDay.month() + 1 !== plan.month
        ) {
          continue;
        }
        await tx.schedule.upsert({
          where: {
            employeeId_date: {
              employeeId: entry.employeeId,
              date: entry.workDate,
            },
          },
          create: {
            employeeId: entry.employeeId,
            shiftId: entry.shiftId,
            date: entry.workDate,
            status: this.mapEntryTypeToScheduleStatus(entry.entryType),
            note: entry.note,
            sourcePlanId: plan.id,
            sourceEntryId: entry.id,
          },
          update: {
            shiftId: entry.shiftId,
            status: this.mapEntryTypeToScheduleStatus(entry.entryType),
            note: entry.note,
            sourcePlanId: plan.id,
            sourceEntryId: entry.id,
            scheduleChangeRequestId: null,
          },
        });
      }
      return tx.monthlySchedulePlan.update({
        where: { id: plan.id },
        data: {
          status: MonthlySchedulePlanStatus.APPROVED,
          approvedById,
          approvedAt: new Date(),
          decisionNote: null,
        },
      });
    });
  }

  async rejectPlan(
    hospitalId: string,
    planId: string,
    approvedById: string,
    reason: string,
  ) {
    const plan = await this.getPlanForWorkflow(hospitalId, planId);
    if (plan.status !== MonthlySchedulePlanStatus.SUBMITTED) {
      throw new BadRequestException(
        'Faqat tasdiqlashga yuborilgan grafik rad etiladi',
      );
    }
    return this.prisma.monthlySchedulePlan.update({
      where: { id: plan.id },
      data: {
        status: MonthlySchedulePlanStatus.REJECTED,
        approvedById,
        approvedAt: new Date(),
        decisionNote: reason.trim(),
      },
    });
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
    if (
      dayjs(primary.workDate).tz(TZ).isBefore(dayjs().tz(TZ).startOf('day'))
    ) {
      throw new BadRequestException(
        'O‘tib ketgan smenani o‘zgartirib bo‘lmaydi',
      );
    }

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
    if (
      dayjs(primary.workDate).tz(TZ).isBefore(dayjs().tz(TZ).startOf('day'))
    ) {
      throw new BadRequestException(
        'O‘tib ketgan smenani o‘zgartirib bo‘lmaydi',
      );
    }

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
        replacementEmployee: { select: { userId: true } },
        counterpartEntry: {
          include: { employee: { select: { userId: true } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Smena o‘zgarishi topilmadi');
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

      return tx.scheduleChangeRequest.update({
        where: { id: request.id },
        data: {
          status: ScheduleChangeStatus.APPROVED,
          approvedById,
          approvedAt: new Date(),
        },
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
    const updated = await this.prisma.scheduleChangeRequest.update({
      where: { id: request.id },
      data: {
        status: ScheduleChangeStatus.REJECTED,
        approvedById,
        approvedAt: new Date(),
        decisionNote: reason.trim(),
      },
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
    return plan;
  }

  private buildPlanSummary(plan: {
    year: number;
    month: number;
    post: { dailyCoverageMinutes: number };
    entries: Array<{
      employeeId: string;
      entryType: SchedulePlanEntryType;
      startsAt: Date | null;
      endsAt: Date | null;
    }>;
  }) {
    const targetMinutes = calculateMonthlyCoverageMinutes(
      plan.year,
      plan.month,
      plan.post.dailyCoverageMinutes,
    );
    const summary = calculateCoverageSummary(
      plan.entries,
      plan.year,
      plan.month,
      targetMinutes,
    );
    const daysInMonth = new Date(
      Date.UTC(plan.year, plan.month, 0),
    ).getUTCDate();
    const days = Array.from({ length: daysInMonth }, (_, index) => {
      const date = `${plan.year}-${String(plan.month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
      return {
        date,
        plannedMinutes: summary.byDate[date] ?? 0,
        targetMinutes: plan.post.dailyCoverageMinutes,
      };
    });
    return { ...summary, days };
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
    await this.markOriginalEmployeeAbsent(tx, request);
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
