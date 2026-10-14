import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  TZ,
  isFastTimezonePath,
  localDateParts,
  localMonthBoundsMs,
  splitIntervalMinutesByLocalDate,
  splitIntervalMinutesByLocalDateLegacy,
} from './schedule-planning-time';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Takrorlanadigan tasodifiy sonlar — test har safar bir xil ishlashi uchun. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('schedule planning fast timezone math', () => {
  it('uses the fast path for Asia/Tashkent (fixed UTC+5)', () => {
    expect(TZ).toBe('Asia/Tashkent');
    expect(isFastTimezonePath()).toBe(true);
  });

  it('splits a night shift 20:00-08:00 as 4h + 8h', () => {
    expect(
      splitIntervalMinutesByLocalDate(
        new Date('2026-10-05T20:00:00+05:00'),
        new Date('2026-10-06T08:00:00+05:00'),
        2026,
        10,
      ),
    ).toEqual({ '2026-10-05': 240, '2026-10-06': 480 });
  });

  it('clips the last night of the month at the month boundary', () => {
    expect(
      splitIntervalMinutesByLocalDate(
        new Date('2026-10-31T20:00:00+05:00'),
        new Date('2026-11-01T08:00:00+05:00'),
        2026,
        10,
      ),
    ).toEqual({ '2026-10-31': 240 });
    expect(
      splitIntervalMinutesByLocalDate(
        new Date('2026-10-31T20:00:00+05:00'),
        new Date('2026-11-01T08:00:00+05:00'),
        2026,
        11,
      ),
    ).toEqual({ '2026-11-01': 480 });
  });

  it('rejects an empty or reversed interval', () => {
    const at = new Date('2026-10-05T08:00:00+05:00');
    expect(splitIntervalMinutesByLocalDate(at, at, 2026, 10)).toBeNull();
    expect(
      splitIntervalMinutesByLocalDate(at, new Date('invalid'), 2026, 10),
    ).toBeNull();
  });

  it('matches the previous dayjs implementation on 4 000 random shifts', () => {
    const random = seededRandom(20261014);
    const from = Date.UTC(2025, 0, 1);
    const span = Date.UTC(2028, 0, 1) - from;
    for (let index = 0; index < 4_000; index += 1) {
      // Daqiqa, ba'zan soniya aniqligida — kesish qoidasi ham tekshiriladi.
      const step = random() < 0.2 ? 1000 : 60_000;
      const start = from + Math.floor((random() * span) / step) * step;
      const duration =
        Math.max(1, Math.floor((random() * 50 * 3_600_000) / step)) * step;
      const startsAt = new Date(start);
      const endsAt = new Date(start + duration);
      const local = localDateParts(startsAt);
      const month = random() < 0.5 ? local.month : (local.month % 12) + 1;
      const year = month < local.month ? local.year + 1 : local.year;

      expect(
        splitIntervalMinutesByLocalDate(startsAt, endsAt, year, month),
      ).toEqual(
        splitIntervalMinutesByLocalDateLegacy(startsAt, endsAt, year, month),
      );
    }
  });

  it('matches dayjs for local date parts and month bounds', () => {
    const random = seededRandom(7);
    const from = Date.UTC(2025, 0, 1);
    const span = Date.UTC(2028, 0, 1) - from;
    for (let index = 0; index < 2_000; index += 1) {
      const value = new Date(from + Math.floor(random() * span));
      const expected = dayjs(value).tz(TZ);
      expect(localDateParts(value)).toEqual({
        year: expected.year(),
        month: expected.month() + 1,
        day: expected.date(),
        weekday: expected.day(),
        iso: expected.format('YYYY-MM-DD'),
      });
    }
    for (let month = 1; month <= 12; month += 1) {
      const start = dayjs.tz(`2026-${String(month).padStart(2, '0')}-01`, TZ);
      expect(localMonthBoundsMs(2026, month)).toEqual({
        startMs: start.valueOf(),
        endMs: start.add(1, 'month').valueOf(),
      });
    }
  });
});
