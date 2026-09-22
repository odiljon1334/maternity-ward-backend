import { BadRequestException } from '@nestjs/common';
import { SchedulePlanEntryType } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

export interface WorkingEntryInterval {
  id?: string;
  employeeId: string;
  entryType: SchedulePlanEntryType;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
}

export interface CoverageSummary {
  targetMinutes: number;
  plannedMinutes: number;
  remainingMinutes: number;
  excessMinutes: number;
  byDate: Record<string, number>;
  byEmployee: Record<string, number>;
}

export function splitIntervalByCalendarDate(
  startsAt: Date | string,
  endsAt: Date | string,
  year: number,
  month: number,
): Record<string, number> {
  const start = dayjs(startsAt).tz(TZ);
  const end = dayjs(endsAt).tz(TZ);
  if (!start.isValid() || !end.isValid() || !end.isAfter(start)) {
    throw new BadRequestException('Smena boshlanish va tugash vaqti noto‘g‘ri');
  }

  const monthStart = dayjs.tz(
    `${year}-${String(month).padStart(2, '0')}-01`,
    TZ,
  );
  const monthEnd = monthStart.add(1, 'month');
  let cursor = start.isBefore(monthStart) ? monthStart : start;
  const clippedEnd = end.isAfter(monthEnd) ? monthEnd : end;
  const result: Record<string, number> = {};

  while (cursor.isBefore(clippedEnd)) {
    const nextDay = cursor.add(1, 'day').startOf('day');
    const segmentEnd = nextDay.isBefore(clippedEnd) ? nextDay : clippedEnd;
    const key = cursor.format('YYYY-MM-DD');
    result[key] = (result[key] ?? 0) + segmentEnd.diff(cursor, 'minute');
    cursor = segmentEnd;
  }

  return result;
}

export function calculateCoverageSummary(
  entries: WorkingEntryInterval[],
  year: number,
  month: number,
  targetMinutes: number,
): CoverageSummary {
  const byDate: Record<string, number> = {};
  const byEmployee: Record<string, number> = {};

  for (const entry of entries) {
    if (entry.entryType !== SchedulePlanEntryType.WORKING) continue;
    if (!entry.startsAt || !entry.endsAt) {
      throw new BadRequestException('Ish smenasida vaqtlar majburiy');
    }
    const segments = splitIntervalByCalendarDate(
      entry.startsAt,
      entry.endsAt,
      year,
      month,
    );
    const minutes = Object.values(segments).reduce(
      (sum, value) => sum + value,
      0,
    );
    byEmployee[entry.employeeId] =
      (byEmployee[entry.employeeId] ?? 0) + minutes;
    for (const [date, value] of Object.entries(segments)) {
      byDate[date] = (byDate[date] ?? 0) + value;
    }
  }

  const plannedMinutes = Object.values(byDate).reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    targetMinutes,
    plannedMinutes,
    remainingMinutes: Math.max(0, targetMinutes - plannedMinutes),
    excessMinutes: Math.max(0, plannedMinutes - targetMinutes),
    byDate,
    byEmployee,
  };
}

export function assertNoEmployeeOverlaps(entries: WorkingEntryInterval[]) {
  const grouped = new Map<string, WorkingEntryInterval[]>();
  for (const entry of entries) {
    if (
      entry.entryType !== SchedulePlanEntryType.WORKING ||
      !entry.startsAt ||
      !entry.endsAt
    ) {
      continue;
    }
    const list = grouped.get(entry.employeeId) ?? [];
    list.push(entry);
    grouped.set(entry.employeeId, list);
  }

  for (const [employeeId, employeeEntries] of grouped) {
    employeeEntries.sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
    for (let index = 1; index < employeeEntries.length; index += 1) {
      const previous = employeeEntries[index - 1];
      const current = employeeEntries[index];
      if (new Date(current.startsAt) < new Date(previous.endsAt)) {
        throw new BadRequestException(
          `Xodimning smenalari kesishmoqda: ${employeeId}`,
        );
      }
    }
  }
}
