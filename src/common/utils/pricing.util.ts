/**
 * StaffPlusPRO — YAGONA narx hisoblash manbai (backend, single source of truth).
 *
 * Frontenddagi lib/pricing.ts bilan bir xil qoidalar (2026-09-20'da Odiljon
 * tomonidan tasdiqlangan). Ikkala repo mustaqil bo'lgani uchun mantiq
 * takrorlangan — o'zgartirishda IKKALASINI ham yangilash kerak.
 *
 * TARIX: loyihada bir vaqtning o'zida 4 xil, bir-biriga mos kelmaydigan
 * narx sxemasi ishlatilib kelingan (marketing matni, kalkulyatorlar,
 * to'lov/qarzdorlik hisobi — PRICE_PER_EMPLOYEE = 20_000, va Telegram bot
 * to'lov summasi — 12_000/xodim). Bu fayl endi hammasi uchun yagona manba.
 *
 * Bosqichlar:
 *  - 1–14 xodim:    "Start" — FIKS oylik to'lov 599 000 so'm (chegirma,
 *                   asl narx 699 000 so'm).
 *  - 15–199 xodim:  "Biznes" — 15 000 so'm / xodim / oy.
 *  - 200–500 xodim: "Korporativ" — 12 000 so'm / xodim / oy.
 *  - 501+ xodim:    Kelishiladi (individual so'zlashuv, aniq narx yo'q).
 *
 * Yillik to'lov qoidasi: oylik narx × 10 (ya'ni 2 oy BEPUL).
 */

export type PlanSlug = 'start' | 'biznes' | 'korporativ';

export interface StaffPricing {
  plan: PlanSlug;
  planLabel: string;
  isFlat: boolean;
  negotiated: boolean;
  /** Faqat "start" bosqichida — so'm/oy, aks holda null */
  flatMonthly: number | null;
  /** Faqat "start" bosqichida — chegirmagacha bo'lgan asl narx, so'm/oy */
  flatMonthlyOriginal: number | null;
  /** "biznes"/"korporativ" bosqichlarida — so'm/xodim/oy, aks holda null */
  perEmployeeMonthly: number | null;
  /** "biznes"/"korporativ" bosqichlarida — so'm/xodim/yil (oylik × 10) */
  perEmployeeAnnual: number | null;
  /** Hisoblangan umumiy oylik to'lov (negotiated bo'lsa — null) */
  monthlyTotal: number | null;
  /** Hisoblangan umumiy yillik to'lov (negotiated bo'lsa — null) */
  annualTotal: number | null;
}

const ANNUAL_MULTIPLIER = 10; // 12 oy narxi o'rniga 10 oy — 2 oy bepul

/** 501+ (kelishiladi) uchun ichki hisob-kitoblarda (masalan, qarzdorlik
 *  hisobida) ishlatiladigan zaxira stavka — Korporativ tarifining eng
 *  yuqori chegarasidagi narx bilan bir xil. Mijozga ko'rsatilmaydi. */
const NEGOTIATED_FALLBACK_PER_EMPLOYEE = 12_000;

export function getStaffPricing(staffCount: number): StaffPricing {
  const n = Math.max(0, Math.floor(staffCount || 0));

  if (n <= 14) {
    const flatMonthly = 599_000;
    return {
      plan: 'start',
      planLabel: 'Start',
      isFlat: true,
      negotiated: false,
      flatMonthly,
      flatMonthlyOriginal: 699_000,
      perEmployeeMonthly: null,
      perEmployeeAnnual: null,
      monthlyTotal: flatMonthly,
      annualTotal: flatMonthly * ANNUAL_MULTIPLIER,
    };
  }

  if (n <= 199) {
    const perEmployeeMonthly = 15_000;
    return {
      plan: 'biznes',
      planLabel: 'Biznes',
      isFlat: false,
      negotiated: false,
      flatMonthly: null,
      flatMonthlyOriginal: null,
      perEmployeeMonthly,
      perEmployeeAnnual: perEmployeeMonthly * ANNUAL_MULTIPLIER,
      monthlyTotal: perEmployeeMonthly * n,
      annualTotal: perEmployeeMonthly * ANNUAL_MULTIPLIER * n,
    };
  }

  if (n <= 500) {
    const perEmployeeMonthly = 12_000;
    return {
      plan: 'korporativ',
      planLabel: 'Korporativ',
      isFlat: false,
      negotiated: false,
      flatMonthly: null,
      flatMonthlyOriginal: null,
      perEmployeeMonthly,
      perEmployeeAnnual: perEmployeeMonthly * ANNUAL_MULTIPLIER,
      monthlyTotal: perEmployeeMonthly * n,
      annualTotal: perEmployeeMonthly * ANNUAL_MULTIPLIER * n,
    };
  }

  // 501+ — kelishiladi
  return {
    plan: 'korporativ',
    planLabel: 'Korporativ',
    isFlat: false,
    negotiated: true,
    flatMonthly: null,
    flatMonthlyOriginal: null,
    perEmployeeMonthly: null,
    perEmployeeAnnual: null,
    monthlyTotal: null,
    annualTotal: null,
  };
}

/**
 * Ichki hisob-kitoblar (to'lov/qarzdorlik nazorati) uchun — HAR DOIM
 * raqam qaytaradi, hatto "kelishiladi" (501+) holatida ham (zaxira stavka
 * bilan taxminiy summa hisoblanadi, chunki qarzdorlik moduli arifmetika
 * uchun aniq raqam talab qiladi).
 */
export function getMonthlyExpectedAmount(staffCount: number): number {
  const n = Math.max(0, Math.floor(staffCount || 0));

  // 0 faol xodim — hali hech kim ro'yxatga olinmagan (odatda yangi
  // ulangan, sozlanayotgan kasalxona). Bunday holatda qarzdorlik
  // hisoblanmaydi (mavjud xatti-harakat — eski PRICE_PER_EMPLOYEE * 0 = 0
  // bilan bir xil natija saqlanadi).
  if (n === 0) return 0;

  const pricing = getStaffPricing(n);
  if (pricing.monthlyTotal !== null) return pricing.monthlyTotal;

  // negotiated (501+) — zaxira stavka bilan taxminiy hisob
  return n * NEGOTIATED_FALLBACK_PER_EMPLOYEE;
}

export function formatSom(value: number): string {
  return new Intl.NumberFormat('uz-UZ')
    .format(Math.round(value))
    .replace(/,/g, ' ');
}
