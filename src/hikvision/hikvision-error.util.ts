/**
 * Hikvision terminal xatolarini foydalanuvchi tushunadigan matnga o'giradi.
 *
 * Terminal xom holda quyidagicha javob beradi:
 *   Hikvision Gateway HTTP 403: {"errorCode":805339143,
 *     "errorMsg":"The device is offline.","subStatusCode":"theDeviceIsOffline"}
 *
 * Kadr xodimi uchun bu tushunarsiz. Bu yerda har bir holat uchun
 * NIMA BO'LGANI va NIMA QILISH KERAKLIGI aytiladi.
 */

interface ErrorRule {
  /** Xato matnida qidiriladigan namuna */
  match: RegExp;
  /** Foydalanuvchiga ko'rsatiladigan izoh */
  message: string;
}

const RULES: ErrorRule[] = [
  {
    match: /theDeviceIsOffline|device is offline/i,
    message:
      "terminal o'chiq yoki tarmoqqa ulanmagan. Terminalni yoqing va rasmni qayta yuklang",
  },
  {
    match: /deviceNotExist|no such device/i,
    message:
      "terminal tizimda ro'yxatdan o'tmagan. Sozlamalar > Terminallar bo'limini tekshiring",
  },
  {
    match: /lowFaceQuality|faceQuality|noFaceDetected|faceRecogn/i,
    message:
      "terminal rasmda yuzni aniq ajrata olmadi. Yorug' joyda, yuz to'liq va to'g'ri qaragan holda qayta suratga oling",
  },
  {
    match: /urlDownloadFail|downloadFail/i,
    message:
      "terminal rasmni yuklab ololmadi (tarmoq sekin bo'lishi mumkin). Birozdan keyin qayta urinib ko'ring",
  },
  {
    match: /faceLibNotExist|FDLib/i,
    message:
      "terminalda yuzlar kutubxonasi topilmadi. Terminal sozlamalarini tekshiring",
  },
  {
    match: /exceedMaxNum|notEnoughSpace|insufficient/i,
    message: "terminal xotirasi to'lgan. Eski yozuvlarni tozalash kerak",
  },
  {
    match: /ECONNABORTED|timeout of \d+ms|ETIMEDOUT/i,
    message:
      "terminal javob bermadi (vaqt tugadi). Tarmoq aloqasini tekshiring",
  },
  {
    match: /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up/i,
    message: "terminalga ulanib bo'lmadi. Tarmoq aloqasini tekshiring",
  },
  {
    match: /401|Unauthorized|authFail|passwordError/i,
    message:
      "terminal login/parol qabul qilmadi. Terminal sozlamalarini tekshiring",
  },
];

/**
 * Xom xatoni qisqa, tushunarli izohga aylantiradi.
 * Noma'lum xato bo'lsa — asl matnning qisqartmasi qaytariladi.
 */
export function describeHikvisionError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';

  for (const rule of RULES) {
    if (rule.match.test(raw)) return rule.message;
  }

  // Noma'lum holat — texnik matnni qisqartirib beramiz
  const short = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  return short || "noma'lum xatolik";
}
