import * as Sentry from '@sentry/nestjs';

/**
 * Sentry — xatoliklarni kuzatish (Faza 3). SENTRY_DSN berilmagan bo'lsa
 * (masalan lokal dev muhitida) Sentry umuman ishga tushmaydi — hech qanday
 * tarmoq so'rovi yubormaydi, hech qanday xatti-harakatga ta'sir qilmaydi.
 *
 * Bu fayl main.ts'da ENG BIRINCHI import qilinishi SHART (boshqa barcha
 * modullardan oldin) — Sentry'ning avtomatik instrumentatsiyasi
 * (http, database so'rovlari va h.k.) shunga bog'liq.
 */
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Standart: performance tracing o'chirilgan (0) — faqat xatoliklar
    // kuzatiladi. Kerak bo'lsa SENTRY_TRACES_SAMPLE_RATE bilan yoqiladi.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
}
