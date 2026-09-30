import { BadRequestException } from '@nestjs/common';
import {
  SchedulePlanEntryType,
  SchedulePostCoverageMode,
} from '@prisma/client';
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

export interface PostCoveragePolicy {
  coverageMode: SchedulePostCoverageMode;
  dailyCoverageMinutes: number;
  /** Yakshanba (0) dan Shanba (6) gacha. */
  coverageMinutesByWeekday: number[] | null;
}

export function normalizePostCoveragePolicy(input: {
  coverageMode?: SchedulePostCoverageMode | null;
  dailyCoverageMinutes?: number | null;
  coverageMinutesByWeekday?: unknown;
}): PostCoveragePolicy {
  const coverageMode =
    input.coverageMode ?? SchedulePostCoverageMode.CONTINUOUS_24_7;
  const requestedDaily = input.dailyCoverageMinutes ?? 1440;

  if (
    !Number.isInteger(requestedDaily) ||
    requestedDaily < 1 ||
    requestedDaily > 1440
  ) {
    throw new BadRequestException(
      'Kunlik post qamrovi 1–1440 daqiqa oralig‘ida bo‘lishi kerak',
    );
  }

  if (coverageMode === SchedulePostCoverageMode.CONTINUOUS_24_7) {
    return {
      coverageMode,
      dailyCoverageMinutes: 1440,
      coverageMinutesByWeekday: null,
    };
  }

  if (coverageMode === SchedulePostCoverageMode.CUSTOM_WEEKLY) {
    const weekly = input.coverageMinutesByWeekday;
    if (
      !Array.isArray(weekly) ||
      weekly.length !== 7 ||
      weekly.some(
        (minutes) =>
          !Number.isInteger(minutes) || minutes < 0 || minutes > 1440,
      )
    ) {
      throw new BadRequestException(
        'Haftalik qamrov Yakshanbadan Shanbagacha 7 ta 0–1440 daqiqalik qiymatdan iborat bo‘lishi kerak',
      );
    }
    if (!weekly.some((minutes) => minutes > 0)) {
      throw new BadRequestException(
        'Haftalik qamrovda kamida bitta ish kuni bo‘lishi kerak',
      );
    }
    return {
      coverageMode,
      dailyCoverageMinutes: Math.max(...weekly),
      coverageMinutesByWeekday: [...weekly],
    };
  }

  return {
    coverageMode,
    dailyCoverageMinutes: requestedDaily,
    coverageMinutesByWeekday: null,
  };
}

export function coverageTargetForDate(
  date: Date | string,
  policy: PostCoveragePolicy,
): number {
  const weekday = dayjs(date).tz(TZ).day();
  if (policy.coverageMode === SchedulePostCoverageMode.WEEKDAYS) {
    return weekday >= 1 && weekday <= 5 ? policy.dailyCoverageMinutes : 0;
  }
  if (policy.coverageMode === SchedulePostCoverageMode.CUSTOM_WEEKLY) {
    return policy.coverageMinutesByWeekday?.[weekday] ?? 0;
  }
  return policy.dailyCoverageMinutes;
}

export function calculateMonthlyCoverageTargets(
  year: number,
  month: number,
  policy: PostCoveragePolicy,
): { targetMinutes: number; byDate: Record<string, number> } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byDate: Record<string, number> = {};
  let targetMinutes = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const minutes = coverageTargetForDate(`${date}T12:00:00+05:00`, policy);
    byDate[date] = minutes;
    targetMinutes += minutes;
  }
  return { targetMinutes, byDate };
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
