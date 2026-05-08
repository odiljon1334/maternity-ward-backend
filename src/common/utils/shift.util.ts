/**
 * Shift uchun yordamchi funksiyalar:
 * - Tushlik vaqtini avtomatik hisoblash
 * - Sof ish vaqtini (netWorkMin) hisoblash
 */

const LUNCH_DURATION_MIN  = 60;  // 1 soat tushlik
const MIN_WORK_FOR_LUNCH  = 240; // 4 soatdan ko'p bo'lsa tushlik qo'shiladi

/** HH:MM satrini daqiqaga o'girish */
function toMin(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Daqiqani HH:MM ga o'girish */
function toTime(min: number): string {
  const h = Math.floor((min % (24 * 60)) / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Shift davomiyligiga qarab tushlik vaqtini avtomatik hisoblash.
 *
 * Qoida:
 *   - Davomiylik ≤ 4 soat  →  tushlik yo'q (null, null)
 *   - Davomiylik >  4 soat →  tushlikStart = start + 4h, tushlikEnd = tushlikStart + 1h
 *
 * Misol:
 *   08:00–12:00  (4h)  →  tushlik yo'q
 *   08:00–14:00  (6h)  →  12:00–13:00
 *   09:00–15:00  (6h)  →  13:00–14:00
 *   10:00–17:00  (7h)  →  14:00–15:00
 *   08:00–17:00  (9h)  →  12:00–13:00
 */
export function calcAutoLunch(
  startTime: string,
  endTime: string,
  isOvernight = false,
): { lunchStart: string | null; lunchEnd: string | null } {
  const startMin = toMin(startTime);
  const endMin   = toMin(endTime);

  let durationMin = endMin - startMin;
  if (isOvernight || durationMin <= 0) durationMin += 24 * 60;

  if (durationMin <= MIN_WORK_FOR_LUNCH) {
    return { lunchStart: null, lunchEnd: null };
  }

  const lunchStartMin = startMin + MIN_WORK_FOR_LUNCH;
  const lunchEndMin   = lunchStartMin + LUNCH_DURATION_MIN;

  return {
    lunchStart: toTime(lunchStartMin),
    lunchEnd:   toTime(lunchEndMin),
  };
}

/**
 * Sof ish vaqtini (daqiqada) hisoblash — tushlik vaqti ayirib tashlanadi.
 *
 * @param checkIn        - Kelish vaqti
 * @param checkOut       - Ketish vaqti
 * @param lunchOut       - Tushlikka chiqqan vaqt (ixtiyoriy)
 * @param lunchIn        - Tushlikdan qaytgan vaqt (ixtiyoriy)
 * @param shiftLunchStart - Smenaning rejalashtirilgan tushlik boshi (ixtiyoriy)
 * @param shiftLunchEnd   - Smenaning rejalashtirilgan tushlik oxiri (ixtiyoriy)
 */
export function calcNetWorkMin(
  checkIn:         Date,
  checkOut:        Date,
  lunchOut?:       Date | null,
  lunchIn?:        Date | null,
  shiftLunchStart?: string | null,
  shiftLunchEnd?:   string | null,
): number {
  const grossMin = Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60_000));

  // Haqiqiy tushlik vaqti (skanerlangan bo'lsa)
  if (lunchOut && lunchIn && lunchIn > lunchOut) {
    const actualLunchMin = Math.round((lunchIn.getTime() - lunchOut.getTime()) / 60_000);
    return Math.max(0, grossMin - actualLunchMin);
  }

  // Agar skanerlangan bo'lmasa lekin smenada tushlik belgilangan bo'lsa
  if (shiftLunchStart && shiftLunchEnd) {
    const plannedMin = toMin(shiftLunchEnd) - toMin(shiftLunchStart);
    return Math.max(0, grossMin - Math.max(0, plannedMin));
  }

  return grossMin;
}
