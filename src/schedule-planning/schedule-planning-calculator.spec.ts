import { BadRequestException } from '@nestjs/common';
import { SchedulePlanEntryType } from '@prisma/client';
import {
  assertNoEmployeeOverlaps,
  calculateCoverageSummary,
  splitIntervalByCalendarDate,
} from './schedule-planning-calculator';

describe('post schedule calculator', () => {
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
