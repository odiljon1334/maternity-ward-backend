import { BadRequestException } from '@nestjs/common';
import {
  SchedulePlanEntryType,
  SchedulePostCoverageMode,
} from '@prisma/client';
import {
  localDateParts,
  splitIntervalMinutesByLocalDate,
} from './schedule-planning-time';

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
  const weekday = localDateParts(date).weekday;
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
  const result = splitIntervalMinutesByLocalDate(startsAt, endsAt, year, month);
  if (!result) {
    throw new BadRequestException('Smena boshlanish va tugash vaqti noto‘g‘ri');
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

export type ShiftKind = 'DAY' | 'NIGHT';

export interface EmployeeShiftStats {
  /** Shu oyda boshlangan kunduzgi smenalar soni */
  dayShifts: number;
  /** Kunduzgi smenalarning shu oy kalendar kunlariga tushgan daqiqalari */
  dayMinutes: number;
  /** Shu oyda boshlangan kechki smenalar soni */
  nightShifts: number;
  /** Kechki smenalarning shu oyga tushgan daqiqalari (20:00–08:00 → 4 + 8) */
  nightMinutes: number;
  totalMinutes: number;
}

/**
 * Smena kunduzgimi yoki kechki.
 *
 * Shablon turi ustun: DAYTIME (08:00–20:00) — kunduzgi, NIGHTTIME
 * (20:00–08:00) — kechki. CUSTOM yoki shablonsiz smena yarim tundan o'tsa
 * kechki, aks holda kunduzgi hisoblanadi.
 */
export function classifyShiftKind(entry: {
  shift?: { type?: string | null } | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  calendarMinutes?: Record<string, number> | null;
}): ShiftKind {
  const type = entry.shift?.type;
  if (type === 'NIGHTTIME') return 'NIGHT';
  if (type === 'DAYTIME') return 'DAY';
  if (entry.startsAt && entry.endsAt) {
    const start = localDateParts(entry.startsAt).iso;
    // Tugash vaqtidan 1 ms oldin: 08:00–24:00 smenasi ertangi kunga o'tmaydi.
    const lastMoment = new Date(new Date(entry.endsAt).getTime() - 1);
    return localDateParts(lastMoment).iso === start ? 'DAY' : 'NIGHT';
  }
  return Object.keys(entry.calendarMinutes ?? {}).length > 1 ? 'NIGHT' : 'DAY';
}

/**
 * Har xodim uchun kunduzgi/kechki smenalar soni va soati.
 *
 * Soat — kalendar bo'yicha (Excel/web katakdagi "4 8" bilan bir xil), shuning
 * uchun kunduzgi + kechki = Jami. Son — shu oyda BOSHLANGAN smenalar:
 * oldingi oydan o'tgan tungi smena (carry-in) soatga qo'shiladi, songa emas.
 */
export function calculateEmployeeShiftStats(
  entries: Array<
    WorkingEntryInterval & {
      workDate?: Date | string | null;
      shift?: { type?: string | null } | null;
      isCarryIn?: boolean;
      calendarMinutes?: Record<string, number> | null;
    }
  >,
  year: number,
  month: number,
): Record<string, EmployeeShiftStats> {
  const result: Record<string, EmployeeShiftStats> = {};
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;

  for (const entry of entries) {
    if (entry.entryType !== SchedulePlanEntryType.WORKING) continue;
    const segments =
      entry.calendarMinutes ??
      (entry.startsAt && entry.endsAt
        ? splitIntervalByCalendarDate(entry.startsAt, entry.endsAt, year, month)
        : null);
    const startedAt = entry.startsAt ?? entry.workDate;
    if (!segments || !startedAt) continue;
    const minutes = Object.values(segments).reduce(
      (sum, value) => sum + value,
      0,
    );
    const startsInMonth =
      !entry.isCarryIn && localDateParts(startedAt).iso.startsWith(monthPrefix);
    if (!minutes && !startsInMonth) continue;

    const stats = (result[entry.employeeId] ??= {
      dayShifts: 0,
      dayMinutes: 0,
      nightShifts: 0,
      nightMinutes: 0,
      totalMinutes: 0,
    });
    if (
      classifyShiftKind({ ...entry, calendarMinutes: segments }) === 'NIGHT'
    ) {
      stats.nightMinutes += minutes;
      if (startsInMonth) stats.nightShifts += 1;
    } else {
      stats.dayMinutes += minutes;
      if (startsInMonth) stats.dayShifts += 1;
    }
    stats.totalMinutes += minutes;
  }

  return result;
}

export interface PostNormBreakdown {
  /** Bitta postning oylik normasi: 31 kunlik oyda 744, 30 kunlikda 720 soat */
  postNormMinutes: number;
  /** To'liq to'ldirilgan postlar soni (2440 soat → 3) */
  fullPostCount: number;
  /** To'liq postlardan ortib qolgan daqiqalar (2440 − 3×744 = 208 soat) */
  remainderMinutes: number;
  /** Oxirgi postni to'ldirish uchun yetmayotgan daqiqalar (744 − 208 = 536) */
  missingMinutes: number;
  /** Shu rejaga kerak bo'ladigan postlar soni (to'liq + chala) */
  postSlots: number;
}

/**
 * Rejadagi post soatlarini postlarga ajratadi.
 *
 * Bo'limda xodim ko'p bo'lsa, post soatlari bir necha normaga teng bo'ladi
 * (masalan 2232 = 3 × 744). Reja faqat soatlar normaga KARRALI bo'lganda
 * yuboriladi; ortib qolgan qismni foydalanuvchi o'zi hal qiladi — oxirgi
 * postni to'ldiradi yoki xodimni «Postdan tashqari» deb belgilaydi. Dastur
 * hech kimni o'zi postdan tashqari qilmaydi.
 */
export function calculatePostNormBreakdown(
  plannedMinutes: number,
  postNormMinutes: number,
): PostNormBreakdown {
  if (postNormMinutes <= 0) {
    return {
      postNormMinutes,
      fullPostCount: 0,
      remainderMinutes: plannedMinutes,
      missingMinutes: 0,
      postSlots: 0,
    };
  }
  const fullPostCount = Math.floor(plannedMinutes / postNormMinutes);
  const remainderMinutes = plannedMinutes - fullPostCount * postNormMinutes;
  const postSlots = Math.max(1, fullPostCount + (remainderMinutes ? 1 : 0));
  return {
    postNormMinutes,
    fullPostCount,
    remainderMinutes,
    missingMinutes: postSlots * postNormMinutes - plannedMinutes,
    postSlots,
  };
}
