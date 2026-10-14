import { BadRequestException } from '@nestjs/common';
import {
  SchedulePlanEntryType,
  SchedulePostCoverageMode,
} from '@prisma/client';
import {
  assertNoEmployeeOverlaps,
  calculateEmployeeShiftStats,
  calculateMonthlyCoverageTargets,
  calculateCoverageSummary,
  calculatePostNormBreakdown,
  classifyShiftKind,
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

  describe('kunduzgi / kechki hisob', () => {
    const shift = (
      employeeId: string,
      start: string,
      end: string,
      type: 'DAYTIME' | 'NIGHTTIME' | 'CUSTOM',
      extra: Record<string, unknown> = {},
    ) => ({
      employeeId,
      entryType: SchedulePlanEntryType.WORKING,
      startsAt: new Date(start),
      endsAt: new Date(end),
      shift: { type },
      ...extra,
    });

    it('classifies by template type, CUSTOM by crossing midnight', () => {
      expect(
        classifyShiftKind(
          shift(
            'e',
            '2026-10-05T08:00:00+05:00',
            '2026-10-05T20:00:00+05:00',
            'DAYTIME',
          ),
        ),
      ).toBe('DAY');
      expect(
        classifyShiftKind(
          shift(
            'e',
            '2026-10-05T20:00:00+05:00',
            '2026-10-06T08:00:00+05:00',
            'NIGHTTIME',
          ),
        ),
      ).toBe('NIGHT');
      expect(
        classifyShiftKind(
          shift(
            'e',
            '2026-10-05T14:00:00+05:00',
            '2026-10-06T00:00:00+05:00',
            'CUSTOM',
          ),
        ),
      ).toBe('DAY');
      expect(
        classifyShiftKind(
          shift(
            'e',
            '2026-10-05T18:00:00+05:00',
            '2026-10-06T02:00:00+05:00',
            'CUSTOM',
          ),
        ),
      ).toBe('NIGHT');
    });

    it('counts shifts started this month and hours by calendar day', () => {
      const stats = calculateEmployeeShiftStats(
        [
          // Oldingi oydan o'tgan tun: 8 soat shu oyga, lekin son emas.
          shift(
            'e1',
            '2026-09-30T20:00:00+05:00',
            '2026-10-01T08:00:00+05:00',
            'NIGHTTIME',
            { isCarryIn: true },
          ),
          shift(
            'e1',
            '2026-10-02T08:00:00+05:00',
            '2026-10-02T20:00:00+05:00',
            'DAYTIME',
          ),
          shift(
            'e1',
            '2026-10-05T20:00:00+05:00',
            '2026-10-06T08:00:00+05:00',
            'NIGHTTIME',
          ),
          // Oy oxiri: 4 soat shu oyga, 8 soat noyabrga.
          shift(
            'e1',
            '2026-10-31T20:00:00+05:00',
            '2026-11-01T08:00:00+05:00',
            'NIGHTTIME',
          ),
          {
            employeeId: 'e1',
            entryType: SchedulePlanEntryType.DAY_OFF,
            startsAt: null,
            endsAt: null,
          },
        ],
        2026,
        10,
      );

      expect(stats.e1).toEqual({
        dayShifts: 1,
        dayMinutes: 12 * 60,
        nightShifts: 2,
        nightMinutes: (8 + 12 + 4) * 60,
        totalMinutes: (12 + 8 + 12 + 4) * 60,
      });
    });
  });

  describe('post normasini postlarga ajratish', () => {
    it('2440 soat = 3 to‘liq post + 208 soat, yana 536 soat kerak', () => {
      expect(calculatePostNormBreakdown(2440 * 60, 744 * 60)).toEqual({
        postNormMinutes: 744 * 60,
        fullPostCount: 3,
        remainderMinutes: 208 * 60,
        missingMinutes: 536 * 60,
        postSlots: 4,
      });
    });

    it('exact multiples have no remainder (30 kunlik oy — 720)', () => {
      expect(calculatePostNormBreakdown(1440 * 60, 720 * 60)).toMatchObject({
        fullPostCount: 2,
        remainderMinutes: 0,
        missingMinutes: 0,
        postSlots: 2,
      });
    });

    it('an empty plan still needs one full post', () => {
      expect(calculatePostNormBreakdown(0, 744 * 60)).toMatchObject({
        fullPostCount: 0,
        missingMinutes: 744 * 60,
        postSlots: 1,
      });
    });
  });
});
