import { applyDecorators, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';

/**
 * Login va parol bilan bog'liq so'rovlar uchun cheklovlar.
 *
 * Nega IP + login: shifoxonada hamma bitta Wi-Fi (NAT) orqali chiqadi va
 * tashqaridan bitta IP bo'lib ko'rinadi. Faqat IP bo'yicha cheklov ertalab
 * 10-xodimdan keyin qolganlarni ham bloklardi. Endi har bir hisobning o'z
 * urinishlari bor (parol taxmin qilishdan himoya saqlanadi), IP bo'yicha
 * esa faqat ancha yuqori umumiy chegara qoladi (ko'p loginlarni ketma-ket
 * sinab chiqishga qarshi).
 *
 * MUHIM: @nestjs/throttler guard'i ThrottlerModule'dagi HAMMA nomli
 * cheklovni har bir guard qo'yilgan route'ga qo'llaydi. Shuning uchun har
 * dekorator o'ziga tegishli bo'lmagan cheklovlarni aniq o'tkazib yuboradi —
 * aks holda login'ga marketing formasi limiti (5 so'rov/soat/IP) ham
 * tushib qolardi (avval aynan shunday bo'lgan).
 */
export const AUTH_THROTTLE_TTL_MS = 900_000; // 15 daqiqa
/** Bitta login uchun bitta IP dan 15 daqiqadagi urinishlar */
export const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
/** Bitta IP dan 15 daqiqadagi barcha login urinishlari (katta shifoxona NAT) */
export const LOGIN_ATTEMPTS_PER_IP = 200;

/** ThrottlerModule nomli cheklovlari (app.module va testlar uchun yagona manba). */
export const THROTTLERS = [
  {
    name: 'login',
    ttl: AUTH_THROTTLE_TTL_MS,
    limit: LOGIN_ATTEMPTS_PER_ACCOUNT,
  },
  { name: 'loginIp', ttl: AUTH_THROTTLE_TTL_MS, limit: LOGIN_ATTEMPTS_PER_IP },
  // Ochiq (marketing) formalar — 5 so'rov / soat / IP
  { name: 'public', ttl: 3_600_000, limit: 5 },
];

function clientIp(req: Record<string, any>): string {
  return String(req?.ip ?? req?.socket?.remoteAddress ?? 'unknown');
}

/** So'rov tanasidagi login (username) — kichik harf, bo'shliqsiz, cheklangan uzunlik. */
function bodyUsername(req: Record<string, any>): string | null {
  const raw = req?.body?.username;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().slice(0, 64);
  return value || null;
}

/** IP + login. Login bo'lmasa (masalan token bilan parol tiklash) — faqat IP. */
export function ipAndUsernameTracker(req: Record<string, any>): string {
  const username = bodyUsername(req);
  return username
    ? `ip:${clientIp(req)}|user:${username}`
    : `ip:${clientIp(req)}`;
}

/** Tizimga kirgan foydalanuvchi bo'yicha (JwtAuthGuard'dan keyin). */
export function authenticatedUserTracker(req: Record<string, any>): string {
  const userId = req?.user?.sub;
  return userId ? `user:${userId}` : `ip:${clientIp(req)}`;
}

/**
 * Login / parol tiklash: har bir hisobga `perAccount` urinish (IP + login),
 * IP dan umumiy `LOGIN_ATTEMPTS_PER_IP`.
 */
export function AuthAttemptThrottle(perAccount = LOGIN_ATTEMPTS_PER_ACCOUNT) {
  return applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle({
      login: {
        ttl: AUTH_THROTTLE_TTL_MS,
        limit: perAccount,
        getTracker: ipAndUsernameTracker,
      },
      loginIp: { ttl: AUTH_THROTTLE_TTL_MS, limit: LOGIN_ATTEMPTS_PER_IP },
    }),
    SkipThrottle({ public: true }),
  );
}

/**
 * Tizimga kirgan foydalanuvchining amallari (token yangilash, parol
 * almashtirish, kod qayta yuborish) — foydalanuvchi bo'yicha hisoblanadi,
 * bir Wi-Fi'dagi hamkasblar bir-biriga xalaqit bermaydi. Controller'da
 * `@UseGuards(JwtAuthGuard, ThrottlerGuard)` tartibi saqlanadi.
 */
export function AuthenticatedUserThrottle(limit: number) {
  return applyDecorators(
    Throttle({
      login: {
        ttl: AUTH_THROTTLE_TTL_MS,
        limit,
        getTracker: authenticatedUserTracker,
      },
    }),
    SkipThrottle({ public: true, loginIp: true }),
  );
}
