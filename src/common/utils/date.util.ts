import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

export const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

export class DateUtil {
  static now(): dayjs.Dayjs {
    return dayjs().tz(TZ);
  }

  static toTz(date: Date | string): dayjs.Dayjs {
    return dayjs(date).tz(TZ);
  }

  static startOfDay(date: Date | string | dayjs.Dayjs): Date {
    return dayjs(date).tz(TZ).startOf('day').toDate();
  }

  static endOfDay(date: Date | string | dayjs.Dayjs): Date {
    return dayjs(date).tz(TZ).endOf('day').toDate();
  }

  static startOfWeek(date: Date | string): Date {
    return dayjs(date).tz(TZ).startOf('isoWeek').toDate();
  }

  static endOfWeek(date: Date | string): Date {
    return dayjs(date).tz(TZ).endOf('isoWeek').toDate();
  }

  static startOfMonth(year: number, month: number): Date {
    return dayjs.tz(`${year}-${String(month).padStart(2, '0')}-01`, TZ).startOf('month').toDate();
  }

  static endOfMonth(year: number, month: number): Date {
    return dayjs.tz(`${year}-${String(month).padStart(2, '0')}-01`, TZ).endOf('month').toDate();
  }

  /**
   * Parse Hikvision terminal time (UTC+5 Toshkent)
   * Terminal sends local time without timezone → we attach +05:00
   */
  static parseTerminalTime(eventTime?: string): Date {
    if (!eventTime) return new Date();
    const hasTimezone = /[Z]$|[+-]\d{2}:?\d{2}$/.test(eventTime.trim());
    const timeStr = !hasTimezone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(eventTime.trim())
      ? `${eventTime.trim()}+05:00`
      : eventTime.trim();
    const parsed = new Date(timeStr);
    if (isNaN(parsed.getTime())) return new Date();
    const serverNow = new Date();
    const diffMs = Math.abs(serverNow.getTime() - parsed.getTime());
    if (parsed > serverNow && diffMs > 60_000) return serverNow;
    if (diffMs > 86_400_000) return serverNow;
    return parsed;
  }

  /**
   * "08:00" + sana → DateTime (UTC saqlash uchun)
   */
  static buildDateTime(date: Date, timeStr: string): Date {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return dayjs(date).tz(TZ).hour(hours).minute(minutes).second(0).millisecond(0).toDate();
  }

  /**
   * Ikkita Date orasidagi farq minutlarda
   */
  static diffMinutes(a: Date, b: Date): number {
    return Math.round((a.getTime() - b.getTime()) / 60_000);
  }
}
