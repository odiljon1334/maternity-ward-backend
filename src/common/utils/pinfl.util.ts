/**
 * JSHSHIR (PINFL) — 14 raqamli shaxsiy identifikator.
 *
 * Bo'shliq va chiziqchalar olib tashlanadi. Bo'sh qiymat — null (maydon
 * ixtiyoriy). Format noto'g'ri bo'lsa `undefined` emas, xato qaytaradi.
 */
export const PINFL_FORMAT_MESSAGE =
  "JSHSHIR 14 ta raqamdan iborat bo'lishi kerak";

export function normalizePinfl(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const digits = String(value).replace(/[\s-]/g, '');
  if (!digits) return { ok: true, value: null };
  return /^\d{14}$/.test(digits) ? { ok: true, value: digits } : { ok: false };
}

/** JSHSHIR'ni ko'ra oladigan rollar (kadrlar va rahbariyat) */
export const PINFL_READER_ROLES: ReadonlySet<string> = new Set([
  'SUPER_ADMIN',
  'ASSISTANT_ADMIN',
  'ADMIN',
  'DIRECTOR',
]);
