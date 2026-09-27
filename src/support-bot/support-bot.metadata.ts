export const SUPPORT_BOT_COMMANDS = [
  {
    command: 'start',
    description: 'Botni ishga tushirish va yordam olish',
  },
  {
    command: 'trial',
    description: '14 kunlik bepul sinovni boshlash',
  },
  {
    command: 'ilova',
    description: 'Xodimlar ilovasini yuklab olish (Android)',
  },
  {
    command: 'operator',
    description: "Jonli operator bilan bog'lanish",
  },
] as const;

/** Jonli operator — StaffPlusPRO jamoasi (sayt va mobil ilovada ham shu) */
export const SUPPORT_OPERATOR_USERNAME = 'staffpluse_support';
export const SUPPORT_OPERATOR_URL = `https://t.me/${SUPPORT_OPERATOR_USERNAME}`;

/**
 * Xodimlar Android ilovasi sahifasi: har doim eng so'nggi APK, QR va
 * yo'riqnoma (latest.json'dan). To'g'ridan-to'g'ri APK havolasi emas —
 * versiya o'zgarganda eskirib qolmasligi uchun.
 */
export const MOBILE_APP_PAGE_URL = 'https://clinicuk24.com/ilova';

export const SUPPORT_APP_MESSAGE = [
  '📱 StaffPlusPRO — xodimlar ilovasi (Android)',
  '',
  `Yuklab olish: ${MOBILE_APP_PAGE_URL}`,
  '',
  "O'rnatish:",
  '1. Havolani telefonda oching va «Android uchun yuklab olish» ni bosing.',
  "2. Telefon so'rasa — brauzerga «Noma'lum manbalardan o'rnatish»ga ruxsat bering.",
  "3. Play Protect ogohlantirsa: «Batafsil» → «Baribir o'rnatish».",
  "4. Muassasangiz bergan login va parol bilan kiring, so'ralgan ruxsatlarni bering.",
  '',
  '🔒 Ilovani faqat shu sahifadan yuklab oling — boshqa joydagi fayllarga ishonmang.',
  `Muammo bo'lsa: @${SUPPORT_OPERATOR_USERNAME}`,
].join('\n');

export const SUPPORT_OPERATOR_MESSAGE =
  `👤 Jonli operator: @${SUPPORT_OPERATOR_USERNAME}\n\n` +
  'Ish vaqtida tez javob beramiz. Savolingizni shu ' +
  'yerga ham yozishingiz mumkin — AI yordamchimiz 24/7 javob beradi.';

export const SUPPORT_BOT_DESCRIPTION =
  "StaffPlusPRO bo'yicha savollaringizga batafsil javob beradigan rasmiy yordamchi. " +
  "Davomat, Face ID, smena, maosh, tariflar va 14 kunlik bepul sinov bo'yicha ma'lumot oling.";

export const SUPPORT_BOT_SHORT_DESCRIPTION =
  "StaffPlusPRO bo'yicha rasmiy yordam va 14 kunlik bepul sinov.";
