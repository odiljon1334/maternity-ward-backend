import { BadRequestException } from '@nestjs/common';
import {
  SchedulePlanEntryType,
  SchedulePostCoverageMode,
} from '@prisma/client';
import {
  assertNoEmployeeOverlaps,
  calculateMonthlyCoverageTargets,
  calculateCoverageSummary,
  normalizePostCoveragePolicy,
  splitIntervalByCalendarDate,
} from './schedule-planning-calculator';

describe('post schedule calculator', () => {
  it('sets zero target on weekends for a weekday-only post', () => {
    const policy = normalizePostCoveragePolicy({
      coverageMode: SchedulePostCoverageMode.WEEKDAYS,
      dailyCoverageMinutes: 480,
    });
    const result = calculateMonthlyCoverageTargets(2026, 10, policy);

    expect(result.byDate['2026-10-03']).toBe(0);
    expect(result.byDate['2026-10-05']).toBe(480);
    expect(result.targetMinutes).toBe(176 * 60);
  });

  it('uses a separate target for every weekday in a custom post', () => {
    const policy = normalizePostCoveragePolicy({
      coverageMode: SchedulePostCoverageMode.CUSTOM_WEEKLY,
      coverageMinutesByWeekday: [0, 480, 720, 180, 0, 360, 0],
    });
    const result = calculateMonthlyCoverageTargets(2026, 10, policy);

    expect(result.byDate['2026-10-05']).toBe(480);
    expect(result.byDate['2026-10-06']).toBe(720);
    expect(result.byDate['2026-10-07']).toBe(180);
    expect(result.byDate['2026-10-08']).toBe(0);
  });

  it('splits 20:00-08:00 as 4 hours and 8 hours', () => {
    const result = splitIntervalByCalendarDate(
      '2026-09-01T20:00:00+05:00',
      '2026-09-02T08:00:00+05:00',
      2026,
      9,
    );

    expect(result).toEqual({
      '2026-09-01': 240,
      '2026-09-02': 480,
    });
  });

  it('clips an overnight shift to the requested month', () => {
    const result = splitIntervalByCalendarDate(
      '2026-08-31T20:00:00+05:00',
      '2026-09-01T08:00:00+05:00',
      2026,
      9,
    );

    expect(result).toEqual({ '2026-09-01': 480 });
  });

  it('keeps employee and post totals in minutes', () => {
    const summary = calculateCoverageSummary(
      [
        {
          employeeId: 'e1',
          entryType: SchedulePlanEntryType.WORKING,
          startsAt: '2026-09-01T20:00:00+05:00',
          endsAt: '2026-09-02T08:00:00+05:00',
        },
      ],
      2026,
      9,
      720 * 60,
    );

    expect(summary.plannedMinutes).toBe(12 * 60);
    expect(summary.byEmployee.e1).toBe(12 * 60);
    expect(summary.remainingMinutes).toBe(708 * 60);
  });

  it('rejects overlapping shifts for one employee', () => {
    expect(() =>
      assertNoEmployeeOverlaps([
        {
          employeeId: 'e1',
          entryType: SchedulePlanEntryType.WORKING,
          startsAt: '2026-09-01T08:00:00+05:00',
          endsAt: '2026-09-01T14:00:00+05:00',
        },
        {
          employeeId: 'e1',
          entryType: SchedulePlanEntryType.WORKING,
          startsAt: '2026-09-01T13:00:00+05:00',
          endsAt: '2026-09-01T16:00:00+05:00',
        },
      ]),
    ).toThrow(BadRequestException);
  });
});
