import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  GenerateScheduleDto,
  BulkGenerateScheduleDto,
  BulkManualScheduleDto,
  SchedulePattern,
} from './dto/generate-schedule.dto';
import { DateUtil } from '../common/utils/date.util';
import { ShiftType, ScheduleStatus } from '@prisma/client';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────
  // GET schedules for employee by month
  // ──────────────────────────────────────────
  async getEmployeeSchedule(employeeId: string, month: number, year: number) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    return this.prisma.schedule.findMany({
      where: {
        employeeId,
        date: { gte: start, lte: end },
      },
      include: {
        shift: true,
        attendance: true,
      },
      orderBy: { date: 'asc' },
    });
  }

  // ──────────────────────────────────────────
  // GET all employees schedules for a day
  // ──────────────────────────────────────────
  async getDailySchedule(date: string) {
    const day = DateUtil.startOfDay(date);
    return this.prisma.schedule.findMany({
      where: {
        date: day,
        status: { in: ['WORKING'] },
      },
      include: {
        employee: { include: { department: true, position: true } },
        shift: true,
        attendance: true,
      },
      orderBy: [{ shift: { type: 'asc' } }, { employee: { fullName: 'asc' } }],
    });
  }

  // ──────────────────────────────────────────
  // GENERATE schedule by pattern
  // ──────────────────────────────────────────
  async generate(dto: GenerateScheduleDto) {
    const { employeeId, month, year, pattern, startsWith, customWeeks } = dto;

    // Verify employee exists
    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    // Get shift templates
    const [dayShift, nightShift] = await Promise.all([
      this.prisma.shiftTemplate.findFirst({ where: { type: 'DAYTIME' } }),
      this.prisma.shiftTemplate.findFirst({ where: { type: 'NIGHTTIME' } }),
    ]);
    if (!dayShift || !nightShift) {
      throw new BadRequestException('Avval smenlarni yarating (POST /shifts/seed)');
    }

    // Generate dates for the month
    const start = dayjs.tz(`${year}-${String(month).padStart(2, '0')}-01`, TZ).startOf('month');
    const end = start.endOf('month');
    const entries: { date: Date; shiftId: string; status: ScheduleStatus }[] = [];

    let current = start;
    while (current.isBefore(end) || current.isSame(end, 'day')) {
      const weekOfMonth = this.getWeekOfMonth(current, start);
      const shiftType = this.resolveShiftForWeek(weekOfMonth, pattern, startsWith, customWeeks);

      const isSunday = current.day() === 0; // 0 = Sunday
      if (isSunday) {
        entries.push({
          date: current.toDate(),
          shiftId: dayShift.id,
          status: 'DAY_OFF',
        });
      } else {
        const shift = shiftType === 'DAYTIME' ? dayShift : nightShift;
        entries.push({
          date: current.toDate(),
          shiftId: shift.id,
          status: 'WORKING',
        });
      }
      current = current.add(1, 'day');
    }

    // Upsert all schedule entries
    let created = 0;
    let updated = 0;

    for (const entry of entries) {
      const dateStart = DateUtil.startOfDay(entry.date);
      const existing = await this.prisma.schedule.findUnique({
        where: { employeeId_date: { employeeId, date: dateStart } },
      });

      if (existing) {
        await this.prisma.schedule.update({
          where: { id: existing.id },
          data: { shiftId: entry.shiftId, status: entry.status },
        });
        updated++;
      } else {
        await this.prisma.schedule.create({
          data: { employeeId, date: dateStart, shiftId: entry.shiftId, status: entry.status },
        });
        created++;
      }
    }

    return {
      message: `Grafik yaratildi: ${created} yangi, ${updated} yangilandi`,
      total: entries.length,
      created,
      updated,
    };
  }

  // ──────────────────────────────────────────
  // BULK GENERATE for multiple employees
  // ──────────────────────────────────────────
  async bulkGenerate(dto: BulkGenerateScheduleDto) {
    const results = [];
    for (const empId of dto.employeeIds) {
      try {
        const result = await this.generate({
          employeeId: empId,
          month: dto.month,
          year: dto.year,
          pattern: dto.pattern,
          startsWith: dto.startsWith,
        });
        results.push({ employeeId: empId, ...result });
      } catch (e) {
        results.push({ employeeId: empId, error: e.message });
      }
    }
    return results;
  }

  // ──────────────────────────────────────────
  // BULK MANUAL schedule
  // ──────────────────────────────────────────
  async bulkManual(dto: BulkManualScheduleDto) {
    const { employeeId, entries } = dto;

    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    let created = 0;
    let updated = 0;

    for (const entry of entries) {
      const dateStart = DateUtil.startOfDay(entry.date);
      const existing = await this.prisma.schedule.findUnique({
        where: { employeeId_date: { employeeId, date: dateStart } },
      });

      const data: any = {
        ...(entry.shiftId && { shiftId: entry.shiftId }),
        ...(entry.status && { status: entry.status as ScheduleStatus }),
        ...(entry.note !== undefined && { note: entry.note }),
      };

      if (existing) {
        await this.prisma.schedule.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await this.prisma.schedule.create({
          data: { employeeId, date: dateStart, ...data },
        });
        created++;
      }
    }

    return { created, updated };
  }

  // ──────────────────────────────────────────
  // UPDATE single schedule entry
  // ──────────────────────────────────────────
  async updateEntry(id: string, data: { shiftId?: string; status?: ScheduleStatus; note?: string }) {
    const entry = await this.prisma.schedule.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Grafik yozuvi topilmadi');
    return this.prisma.schedule.update({ where: { id }, data });
  }

  // ──────────────────────────────────────────
  // HELPER: resolve week of month (0-indexed)
  // ──────────────────────────────────────────
  private getWeekOfMonth(date: Dayjs, monthStart: Dayjs): number {
    const dayOfMonth = date.date();
    return Math.floor((dayOfMonth - 1) / 7);
  }

  private resolveShiftForWeek(
    week: number,             // 0-indexed week of month
    pattern: SchedulePattern,
    startsWith: ShiftType,
    customWeeks?: ShiftType[],
  ): ShiftType {
    const other: ShiftType = startsWith === 'DAYTIME' ? 'NIGHTTIME' : 'DAYTIME';

    if (pattern === SchedulePattern.CUSTOM && customWeeks) {
      return customWeeks[week] || startsWith;
    }

    const patterns: Record<SchedulePattern, ShiftType[]> = {
      [SchedulePattern.TWO_TWO]:   [startsWith, startsWith, other, other],
      [SchedulePattern.ONE_ONE]:   [startsWith, other, startsWith, other],
      [SchedulePattern.THREE_ONE]: [startsWith, startsWith, startsWith, other],
      [SchedulePattern.CUSTOM]:    [startsWith, startsWith, startsWith, startsWith],
    };

    const seq = patterns[pattern];
    return seq[week % seq.length];
  }
}
