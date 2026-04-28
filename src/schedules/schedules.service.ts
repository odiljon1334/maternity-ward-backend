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
  async getDailySchedule(date: string, hospitalId?: string | null) {
    const day = DateUtil.startOfDay(date);
    return this.prisma.schedule.findMany({
      where: {
        date: day,
        status: { in: ['WORKING'] },
        ...(hospitalId && { employee: { hospitalId } }),
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
  // GET monthly schedules (all employees)
  // ──────────────────────────────────────────
  async getMonthlySchedules(month: number, year: number, hospitalId?: string | null) {
    const start = DateUtil.startOfMonth(year, month);
    const end = DateUtil.endOfMonth(year, month);

    return this.prisma.schedule.findMany({
      where: {
        date: { gte: start, lte: end },
        ...(hospitalId && { employee: { hospitalId } }),
      },
      include: {
        shift: true,
        employee: { include: { department: true, position: true } },
      },
      orderBy: [{ employee: { fullName: 'asc' } }, { date: 'asc' }],
    });
  }

  // ──────────────────────────────────────────
  // GENERATE schedule by pattern
  // ──────────────────────────────────────────
  async generate(dto: GenerateScheduleDto) {
    const { employeeId, month, year, pattern, customWeeks, shiftId } = dto;
    // FIXED_DAY/FIXED_NIGHT uchun startsWith shart emas; rotating uchun default DAYTIME
    const startsWith: ShiftType = dto.startsWith ?? 'DAYTIME';
    // Default: Dushanba–Juma (1–5). 0=Yak, 1=Du, 2=Se, 3=Ch, 4=Pa, 5=Sha, 6=Yak
    const workDaysSet = new Set(dto.workDays ?? [1, 2, 3, 4, 5]);

    // Verify employee exists
    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundException('Hodim topilmadi');

    // Get shift templates (with auto-seed fallback)
    let [dayShift, nightShift] = await Promise.all([
      this.prisma.shiftTemplate.findFirst({ where: { hospitalId: emp.hospitalId, type: 'DAYTIME' } })
        .then(s => s || this.prisma.shiftTemplate.findFirst({ where: { type: 'DAYTIME' } })),
      this.prisma.shiftTemplate.findFirst({ where: { hospitalId: emp.hospitalId, type: 'NIGHTTIME' } })
        .then(s => s || this.prisma.shiftTemplate.findFirst({ where: { type: 'NIGHTTIME' } })),
    ]);

    if (!dayShift || !nightShift) {
      if (!emp.hospitalId) {
        throw new BadRequestException("Xodimga kasalxona biriktirilmagan. Avval xodim ma'lumotlarini to'ldiring.");
      }
      // Auto-seed default shifts for this hospital so user doesn't need to go to Settings first
      const seedDefaults = [
        { name: 'Kunduzgi smen', type: 'DAYTIME'   as ShiftType, startTime: '08:00', endTime: '20:00', isOvernight: false, durationH: 12, graceMinutes: 15 },
        { name: 'Kechki smen',   type: 'NIGHTTIME' as ShiftType, startTime: '20:00', endTime: '08:00', isOvernight: true,  durationH: 12, graceMinutes: 15 },
      ];
      for (const s of seedDefaults) {
        await this.prisma.shiftTemplate.upsert({
          where: { hospitalId_name: { hospitalId: emp.hospitalId, name: s.name } },
          update: s,
          create: { ...s, hospitalId: emp.hospitalId },
        });
      }
      // Re-fetch after auto-seed
      [dayShift, nightShift] = await Promise.all([
        this.prisma.shiftTemplate.findFirst({ where: { hospitalId: emp.hospitalId, type: 'DAYTIME' } }),
        this.prisma.shiftTemplate.findFirst({ where: { hospitalId: emp.hospitalId, type: 'NIGHTTIME' } }),
      ]);
      if (!dayShift || !nightShift) {
        throw new BadRequestException("Smenlar yaratib bo'lmadi. Sozlamalar > Smenlar bo'limiga o'ting.");
      }
    }

    // Bitta xodim uchun aniq shift berilgan bo'lsa — uni ishlatamiz
    if (shiftId) {
      const specific = await this.prisma.shiftTemplate.findUnique({ where: { id: shiftId } });
      if (specific) {
        if (specific.type === 'DAYTIME') dayShift = specific;
        else nightShift = specific;
      }
    }
    // Bulk generate'dan kelgan aniq shift IDlar (custom vaqt)
    if ((dto as any).dayShiftId) {
      const s = await this.prisma.shiftTemplate.findUnique({ where: { id: (dto as any).dayShiftId } });
      if (s) dayShift = s;
    }
    if ((dto as any).nightShiftId) {
      const s = await this.prisma.shiftTemplate.findUnique({ where: { id: (dto as any).nightShiftId } });
      if (s) nightShift = s;
    }

    // Generate dates for the month
    const start = dayjs.tz(`${year}-${String(month).padStart(2, '0')}-01`, TZ).startOf('month');
    const end = start.endOf('month');
    const entries: { date: Date; shiftId: string; status: ScheduleStatus }[] = [];

    let current = start;
    while (current.isBefore(end) || current.isSame(end, 'day')) {
      const dayOfWeek = current.day(); // 0=Sun, 1=Mon...6=Sat

      if (!workDaysSet.has(dayOfWeek)) {
        // Dam olish kuni
        entries.push({
          date: current.toDate(),
          shiftId: dayShift.id,
          status: 'DAY_OFF',
        });
      } else {
        const weekOfMonth = this.getWeekOfMonth(current, start);
        const shiftType = this.resolveShiftForWeek(weekOfMonth, pattern, startsWith, customWeeks);
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
  async bulkGenerate(dto: BulkGenerateScheduleDto & { hospitalId?: string | null }) {
    // Bo'lim yoki kasalxona bo'yicha hodimlarni topish
    let employeeIds = dto.employeeIds ?? [];
    if (!employeeIds.length) {
      const empWhere: any = { firedAt: null };
      if (dto.departmentId)  empWhere.departmentId = dto.departmentId;
      if (dto.hospitalId)    empWhere.hospitalId   = dto.hospitalId;
      if (!dto.departmentId && !dto.hospitalId) {
        throw new BadRequestException('employeeIds, departmentId yoki hospitalId kerak');
      }
      const emps = await this.prisma.employee.findMany({ where: empWhere, select: { id: true } });
      employeeIds = emps.map(e => e.id);
    }

    const results = [];
    for (const empId of employeeIds) {
      try {
        const result = await this.generate({
          employeeId: empId,
          month: dto.month,
          year: dto.year,
          pattern: dto.pattern,
          startsWith: dto.startsWith,
          workDays: dto.workDays,
          dayShiftId: dto.dayShiftId,
          nightShiftId: dto.nightShiftId,
        } as any);
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
    // O'zgarmas smenlar
    if (pattern === SchedulePattern.FIXED_DAY)   return 'DAYTIME';
    if (pattern === SchedulePattern.FIXED_NIGHT) return 'NIGHTTIME';

    const other: ShiftType = startsWith === 'DAYTIME' ? 'NIGHTTIME' : 'DAYTIME';

    if (pattern === SchedulePattern.CUSTOM && customWeeks) {
      return customWeeks[week] || startsWith;
    }

    const patterns: Record<string, ShiftType[]> = {
      [SchedulePattern.TWO_TWO]:   [startsWith, startsWith, other, other],
      [SchedulePattern.ONE_ONE]:   [startsWith, other, startsWith, other],
      [SchedulePattern.THREE_ONE]: [startsWith, startsWith, startsWith, other],
      [SchedulePattern.CUSTOM]:    [startsWith, startsWith, startsWith, startsWith],
    };

    const seq = patterns[pattern] ?? [startsWith];
    return seq[week % seq.length];
  }
}
