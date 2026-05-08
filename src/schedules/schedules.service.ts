import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(SchedulesService.name);
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
  // ROLLOVER: copy schedules to next month
  // ──────────────────────────────────────────
  /**
   * fromMonth/Year dagi grafiklarni toMonth/Year ga ko'chiradi.
   * toMonth da allaqachon grafigi bor xodimlar o'tkazib yuboriladi.
   * Har bir kun uchun: toMonth dagi hafta-nomer + hafta-kuni bo'yicha
   * fromMonth dan mos yozuv topiladi — shu smena/status ishlatiladi.
   * (2-2, 1-1, FIXED, va boshqa patternlar to'g'ri saqlanadi)
   */
  async rolloverMonth(
    fromMonth: number, fromYear: number,
    toMonth:   number, toYear:   number,
    hospitalId?: string | null,
  ) {
    const fromStart = DateUtil.startOfMonth(fromYear, fromMonth);
    const fromEnd   = DateUtil.endOfMonth(fromYear, fromMonth);
    const toStart   = DateUtil.startOfMonth(toYear, toMonth);
    const toEnd     = DateUtil.endOfMonth(toYear, toMonth);

    // fromMonth da grafigi bor xodimlar
    const withSchedule = await this.prisma.schedule.findMany({
      where: {
        date: { gte: fromStart, lte: fromEnd },
        ...(hospitalId && { employee: { hospitalId } }),
      },
      select: { employeeId: true },
      distinct: ['employeeId'],
    });
    const employeeIds = withSchedule.map(s => s.employeeId);
    if (!employeeIds.length) return { rolled: 0, skipped: 0, total: 0 };

    // toMonth da allaqachon grafigi borlarni exclude qilish
    const alreadyHas = await this.prisma.schedule.findMany({
      where: {
        date: { gte: toStart, lte: toEnd },
        employeeId: { in: employeeIds },
      },
      select: { employeeId: true },
      distinct: ['employeeId'],
    });
    const alreadyHasIds = new Set(alreadyHas.map(s => s.employeeId));
    const toProcessIds  = employeeIds.filter(id => !alreadyHasIds.has(id));

    if (!toProcessIds.length) {
      return { rolled: 0, skipped: alreadyHasIds.size, total: employeeIds.length,
               message: 'Barcha xodimlar uchun grafik allaqachon mavjud' };
    }

    // fromMonth barcha grafiklarini olish
    const fromSchedules = await this.prisma.schedule.findMany({
      where: {
        date: { gte: fromStart, lte: fromEnd },
        employeeId: { in: toProcessIds },
      },
    });

    // employeeId → Map<"hafta_weekday" → { shiftId, status }>
    const empMap = new Map<string, Map<string, { shiftId: string; status: ScheduleStatus }>>();
    for (const s of fromSchedules) {
      const d = dayjs.tz(s.date, TZ);
      const week = Math.floor((d.date() - 1) / 7); // 0-4
      const dow  = d.day();                          // 0=Yak..6=Sha
      const key  = `${week}_${dow}`;
      if (!empMap.has(s.employeeId)) empMap.set(s.employeeId, new Map());
      empMap.get(s.employeeId)!.set(key, { shiftId: s.shiftId, status: s.status });
    }

    let rolled = 0;
    for (const empId of toProcessIds) {
      const dayMap = empMap.get(empId);
      if (!dayMap) continue;

      let cur = dayjs.tz(
        `${toYear}-${String(toMonth).padStart(2, '0')}-01`, TZ,
      ).startOf('month');
      const end = cur.endOf('month');

      while (cur.isBefore(end) || cur.isSame(end, 'day')) {
        const week = Math.floor((cur.date() - 1) / 7);
        const dow  = cur.day();

        // Shu hafta + weekday bor-yo'qligini tekshirish;
        // yo'q bo'lsa oldingi haftalardan izlash (toMonth fromMonth dan uzunroq bo'lishi mumkin)
        let entry = dayMap.get(`${week}_${dow}`);
        if (!entry) {
          for (let w = week - 1; w >= 0; w--) {
            entry = dayMap.get(`${w}_${dow}`);
            if (entry) break;
          }
        }

        if (entry) {
          const dateStart = DateUtil.startOfDay(cur.toDate());
          await this.prisma.schedule.upsert({
            where:  { employeeId_date: { employeeId: empId, date: dateStart } },
            update: { shiftId: entry.shiftId, status: entry.status },
            create: { employeeId: empId, date: dateStart, shiftId: entry.shiftId, status: entry.status },
          });
        }
        cur = cur.add(1, 'day');
      }
      rolled++;
    }

    return {
      rolled,
      skipped: alreadyHasIds.size,
      total:   employeeIds.length,
      message: `${rolled} ta xodim grafigi ${toMonth}/${toYear} oyiga ko'chirildi`,
    };
  }

  // ──────────────────────────────────────────
  // HELPER: resolve week of month (0-indexed)
  // ──────────────────────────────────────────
  private getWeekOfMonth(date: Dayjs, monthStart: Dayjs): number {
    const dayOfMonth = date.date();
    return Math.floor((dayOfMonth - 1) / 7);
  }

  // ──────────────────────────────────────────
  // XLSX IMPORT — ism bo'yicha grafik yaratish
  // ──────────────────────────────────────────
  /**
   * XLSX/CSV fayldan hodimlar grafigini import qiladi.
   * Fayl formati (har bir qator = 1 xodim):
   *   Col0: Ism familya
   *   Col1: Jinsi (ixtiyoriy)
   *   Col2: Lavozim (ixtiyoriy)
   *   Col3: Qo'shimcha (ixtiyoriy)
   *   Col4: Telefon (ixtiyoriy)
   *   Col5..N: "HH:MM  HH:MM" yoki bo'sh (Dushanba→Yakshanba)
   *
   * Agar 5 ustun bo'lsa: Du–Ju (5 kunlik)
   * Agar 7 ustun bo'lsa: Du–Yak (7 kunlik) — Shanba/Yakshanba ham belgilanadi
   */
  async importXlsx(
    fileBuffer: Buffer,
    month: number,
    year: number,
    hospitalId: string | null,
  ) {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fileBuffer as any);

    // Birinchi ishchi sheet ni topish
    let ws = wb.worksheets.find(s => s.rowCount > 0);
    if (!ws) throw new BadRequestException('Fayl bo\'sh yoki noto\'g\'ri formatda');

    // Kasalxonadagi barcha hodimlarni olish (ism normallashtirish uchun)
    const empWhere: any = { firedAt: null };
    if (hospitalId) empWhere.hospitalId = hospitalId;
    const allEmployees = await this.prisma.employee.findMany({
      where: empWhere,
      select: { id: true, fullName: true, hospitalId: true },
    });

    const normalizeEmpName = (n: string) =>
      n.toLowerCase()
       .replace(/\s+/g, ' ')
       .trim()
       .replace(/[ёъь]/g, '')
       .replace(/ғ/g, 'g').replace(/қ/g, 'q').replace(/ҳ/g, 'h')
       .replace(/ў/g, 'u').replace(/ш/g, 'sh').replace(/ч/g, 'ch');

    const empIndex = new Map<string, string>(); // normalizedName → id
    for (const e of allEmployees) {
      empIndex.set(normalizeEmpName(e.fullName), e.id);
    }

    // Shift cache: "startTime|endTime" → shiftId
    const shiftCache = new Map<string, string>();

    const getOrCreateShift = async (startTime: string, endTime: string, empHospitalId: string | null) => {
      const key = `${startTime}|${endTime}`;
      if (shiftCache.has(key)) return shiftCache.get(key)!;

      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      const isOvernight = (eh * 60 + em) < (sh * 60 + sm);
      let mins = (eh * 60 + em) - (sh * 60 + sm);
      if (mins <= 0) mins += 24 * 60;
      const durationH = Math.round(mins / 60);
      const type: ShiftType = isOvernight || sh >= 18 ? 'NIGHTTIME' : 'DAYTIME';
      const hospId = empHospitalId || hospitalId;

      const existing = await this.prisma.shiftTemplate.findFirst({
        where: { startTime, endTime, ...(hospId && { hospitalId: hospId }) },
      });
      if (existing) { shiftCache.set(key, existing.id); return existing.id; }

      const name = `${type === 'DAYTIME' ? 'Kunduzgi' : 'Kechki'} ${startTime}–${endTime}`;
      const created = await this.prisma.shiftTemplate.create({
        data: { name, type, startTime, endTime, isOvernight, durationH, graceMinutes: 15, hospitalId: hospId },
      });
      shiftCache.set(key, created.id);
      return created.id;
    };

    const parseTime = (raw: string | null): { start: string; end: string } | null => {
      if (!raw) return null;
      // "08:00  16:30" veya "08:00 16:30" veya "08:00-16:30"
      const cleaned = raw.toString().trim().replace(/[–—-]/, ' ').replace(/\s+/, ' ');
      const m = cleaned.match(/(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/);
      if (!m) return null;
      const pad = (t: string) => t.split(':').map(p => p.padStart(2, '0')).join(':');
      return { start: pad(m[1]), end: pad(m[2]) };
    };

    // Hafta kunlari: col offset → JS day (0=Yak, 1=Du...6=Sha)
    // 5 ustunli: Du(1), Se(2), Ch(3), Pa(4), Ju(5)
    // 7 ustunli: Du(1)..Sha(6), Yak(0)
    const dayOfWeekMap5 = [1, 2, 3, 4, 5];
    const dayOfWeekMap7 = [1, 2, 3, 4, 5, 6, 0];

    const monthStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
    const daysInMonth = monthStart.daysInMonth();

    let created = 0, updated = 0, skipped = 0;
    const unmatched: string[] = [];

    // Barcha kunlar uchun hafta-kuni sxemasi
    const dateDowMap: Array<{ dateStr: string; dow: number; date: Date }> = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = monthStart.date(d);
      dateDowMap.push({
        dateStr: dt.format('YYYY-MM-DD'),
        dow: dt.day(),
        date: dt.toDate(),
      });
    }

    ws.eachRow((row, rowNum) => {
      // Bu sinxron emas, async bo'lgani uchun promise massiv orqali ishlaymiz
    });

    // eachRow sinxron — async import uchun rows ni to'plash kerak
    const rows: any[][] = [];
    ws.eachRow((row) => {
      const vals = row.values as any[];
      rows.push(vals.slice(1)); // 0-indexed: vals[0] bo'sh, vals[1]= A ustun
    });

    for (const cols of rows) {
      const rawName = cols[0];
      if (!rawName) continue;
      const nameStr = rawName.toString().trim();
      if (!nameStr) continue;

      const normName = normalizeEmpName(nameStr);
      const empId = empIndex.get(normName);
      if (!empId) {
        // Qisman moslik — first word match
        const firstWord = normName.split(' ')[0];
        const partial = [...empIndex.keys()].find(k => k.startsWith(firstWord));
        if (!partial) { unmatched.push(nameStr); continue; }
        // Partial match found
      }
      const resolvedEmpId = empId ?? [...empIndex.entries()].find(([k]) => normalizeEmpName(k).split(' ')[0] === normalizeEmpName(nameStr).split(' ')[0])?.[1];
      if (!resolvedEmpId) { unmatched.push(nameStr); continue; }

      // Vaqt ustunlarini aniqlash (col index 5+)
      const timeCols = cols.slice(5).filter((v) => v !== undefined);
      const dowMap = timeCols.length >= 7 ? dayOfWeekMap7 : dayOfWeekMap5;

      // Har bir oy kuni uchun schedule yaratish
      for (const { dateStr, dow, date } of dateDowMap) {
        const colIdx = dowMap.indexOf(dow);
        const hasTime = colIdx >= 0 && timeCols[colIdx] != null;
        const rawTime = hasTime ? timeCols[colIdx]?.toString() : null;
        const parsed = hasTime ? parseTime(rawTime) : null;

        let shiftId: string | undefined;
        let status: ScheduleStatus = 'DAY_OFF';

        if (parsed) {
          const emp = allEmployees.find(e => e.id === resolvedEmpId);
          shiftId = await getOrCreateShift(parsed.start, parsed.end, emp?.hospitalId ?? null);
          status = 'WORKING';
        }

        const dateStart = DateUtil.startOfDay(date);
        const existing = await this.prisma.schedule.findUnique({
          where: { employeeId_date: { employeeId: resolvedEmpId, date: dateStart } },
        });

        if (existing) {
          await this.prisma.schedule.update({
            where: { id: existing.id },
            data: { ...(shiftId && { shiftId }), status },
          });
          updated++;
        } else {
          // shiftId bo'lmasa default shift topish
          if (!shiftId) {
            const emp = allEmployees.find(e => e.id === resolvedEmpId);
            const defShift = await this.prisma.shiftTemplate.findFirst({
              where: { ...(emp?.hospitalId && { hospitalId: emp.hospitalId }), type: 'DAYTIME' },
            });
            if (defShift) shiftId = defShift.id;
            else { skipped++; continue; }
          }
          await this.prisma.schedule.create({
            data: { employeeId: resolvedEmpId, date: dateStart, shiftId, status },
          });
          created++;
        }
      }
    }

    return {
      created,
      updated,
      skipped,
      unmatched,
      message: `Import yakunlandi: ${created} yangi, ${updated} yangilandi${unmatched.length ? `, ${unmatched.length} ta topilmadi` : ''}`,
    };
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
