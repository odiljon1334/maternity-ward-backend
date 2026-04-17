import { TerminalEventType } from '@prisma/client';

/**
 * Hikvision terminallari yuboradigan attendanceStatus / workCode qiymatlarini
 * bizning TerminalEventType enum ga moslashtiradi.
 *
 * Hikvision DS-K seriyali terminallar quyidagi qiymatlarni yuboradi:
 *   String: "checkIn" | "checkOut" | "breakOut" | "breakIn" | "overtimeIn" | "overtimeOut"
 *   Number: 0 (undefined) | 1 (checkIn) | 2 (checkOut) | 3 (breakOut) | 4 (breakIn) | 5 | 6
 *
 * Custom workCode (terminal konfiguratsiyasiga qarab):
 *   5 → COFFEE_OUT  (tanaffus chiqish)
 *   6 → COFFEE_IN   (tanaffus qaytish)
 *
 * Yangi terminal modeli qo'shilganda — faqat shu map ni yangilash yetarli.
 */
const STATUS_MAP: Record<string, TerminalEventType> = {
  // ── String values (DS-K1T671 va boshqa DS-K seriyalar) ──────────────────────
  checkin:      TerminalEventType.CHECK_IN,
  checkout:     TerminalEventType.CHECK_OUT,
  breakout:     TerminalEventType.LUNCH_OUT,
  breakin:      TerminalEventType.LUNCH_IN,
  overtimein:   TerminalEventType.OVERTIME_IN,
  overtimeout:  TerminalEventType.OVERTIME_OUT,

  // ── "unKnown" / "undefined" — terminal tugma tanlanmagan ────────────────────
  unknown:      TerminalEventType.UNKNOWN,
  undefined:    TerminalEventType.UNKNOWN,
  none:         TerminalEventType.UNKNOWN,

  // ── Numeric values ───────────────────────────────────────────────────────────
  '0': TerminalEventType.UNKNOWN,        // undefined / not selected
  '1': TerminalEventType.CHECK_IN,
  '2': TerminalEventType.CHECK_OUT,
  '3': TerminalEventType.LUNCH_OUT,
  '4': TerminalEventType.LUNCH_IN,
  '5': TerminalEventType.COFFEE_OUT,     // custom: 5-tugma = Coffee chiqish
  '6': TerminalEventType.COFFEE_IN,      // custom: 6-tugma = Coffee qaytish
  '7': TerminalEventType.OVERTIME_IN,
  '8': TerminalEventType.OVERTIME_OUT,
};

/**
 * Hikvision attendanceStatus yoki workCode qiymatini TerminalEventType ga o'tkazadi.
 *
 * @param raw - terminal dan kelgan qiymat (string | number | null | undefined)
 * @returns TerminalEventType yoki null (qiymat mavjud emas yoki noma'lum bo'lsa)
 */
export function mapHikvisionStatus(
  raw: string | number | null | undefined,
): TerminalEventType | null {
  if (raw === null || raw === undefined || raw === '') return null;

  // "0" va 0 → UNKNOWN (terminal tugma tanlanmagan — fallback logikasi ishlatiladi)
  const normalized = String(raw).toLowerCase().replace(/[\s_\-]/g, '');
  const mapped = STATUS_MAP[normalized];

  if (!mapped || mapped === TerminalEventType.UNKNOWN) return null;
  return mapped;
}
