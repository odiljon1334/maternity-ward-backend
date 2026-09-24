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
    // Shaxsiy ma'lumot yuborilmaydi: IP, cookie/Authorization, so'rov tanasi
    // (parol, telefon, GPS), URL query-string (qidiruvdagi ism va h.k.)
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (b) => {
      if (b.data && typeof b.data.url === 'string') {
        b.data.url = stripQuery(b.data.url);
      }
      return b.category === 'console' ? null : b;
    },
  });
}

function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : `${url.slice(0, i)}?[filtered]`;
}

function scrubSentryEvent<T extends { request?: any; user?: any }>(
  event: T,
): T {
  const req = event.request;
  if (req) {
    if (typeof req.url === 'string') req.url = stripQuery(req.url);
    delete req.query_string;
    delete req.cookies;
    delete req.data;
    if (req.headers) {
      for (const h of Object.keys(req.headers)) {
        if (/^(cookie|authorization|x-hook-signature)$/i.test(h)) {
          delete req.headers[h];
        }
      }
    }
  }
  if (event.user)
    event.user = event.user.id ? { id: event.user.id } : undefined;
  return event;
}
