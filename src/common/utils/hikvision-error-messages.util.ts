/**
 * Hikvision terminal xatolik kodlarini (statusCode / subStatusCode)
 * kasalxona hamshirasi yoki oddiy foydalanuvchi tushunadigan
 * o'zbekcha matnga tarjima qilish.
 *
 * Hikvision ISAPI odatda quyidagi formatda javob qaytaradi:
 * {
 *   "statusCode": 6,
 *   "statusString": "Content Error",
 *   "subStatusCode": "SubpicAnalysisModelingError",
 *   "errorCode": 1610612791,
 *   "errorMsg": ""
 * }
 *
 * Foydalanish:
 *   const friendly = translateHikvisionError(err);
 *   throw new BadRequestException(friendly);
 */

export interface HikvisionErrorShape {
  statusCode?: number;
  statusString?: string;
  subStatusCode?: string;
  errorCode?: number;
  errorMsg?: string;
}

// ─── subStatusCode bo'yicha xaritalash (eng aniq va tez-tez uchraydigani) ───
const SUB_STATUS_MESSAGES: Record<string, string> = {
  // Yuzni tahlil qilib bo'lmadi — sifat yomon, burchak noto'g'ri,
  // yoki rasmda yuz umuman aniqlanmadi
  SubpicAnalysisModelingError:
    "Yuz rasmi terminal tomonidan tan olinmadi. Rasm sifatsiz, yorug'lik yetarli emas yoki yuz to'liq ko'rinmayapti. Aniqroq, old tomondan tushirilgan rasm bilan qayta urinib ko'ring.",

  // Rasmda yuz umuman topilmadi
  NoFaceDetected:
    "Rasmda yuz aniqlanmadi. Iltimos, yuz aniq ko'rinadigan rasm yuklang.",

  // Bir nechta yuz aniqlangan (guruh surati bo'lishi mumkin)
  MultipleFacesDetected:
    "Rasmda bir nechta yuz aniqlandi. Faqat bitta odamning yuzi tushirilgan rasm yuklang.",

  // Rasm format/hajm/o'lcham talablariga mos emas
  PictureFormatError:
    "Rasm formati noto'g'ri. JPEG formatidagi rasm yuklang.",
  PictureSizeError:
    "Rasm hajmi yoki o'lchami talabga mos emas. Kichikroq (odatda 200KB dan kam) va standart o'lchamdagi rasm yuklang.",
  PictureResolutionError:
    "Rasm o'lchami (piksel) talabga mos emas. Terminal talab qiladigan o'lchamdagi rasm yuklang.",

  // Yuz sifati past — ko'zoynak, niqob, burchak, past yorug'lik
  LowQualityFace:
    "Yuz sifati past baholandi (yorug'lik, burchak yoki to'siq sababli). Yaxshi yoritilgan, to'g'ridan tushirilgan rasm bilan qayta urinib ko'ring.",

  // Xodim allaqachon terminalda ro'yxatdan o'tgan
  PersonAlreadyExist:
    "Bu xodim terminalda allaqachon ro'yxatdan o'tgan.",

  // Terminal xotirasi to'lgan
  DeviceStorageFull:
    "Terminal xotirasi to'lgan. Terminalni tekshiring yoki texnik xodimga murojaat qiling.",
};

// ─── statusCode bo'yicha umumiy xaritalash (subStatusCode aniqlanmasa) ───
const STATUS_CODE_MESSAGES: Record<number, string> = {
  1: "So'rov muvaffaqiyatli emas.",
  2: "Terminalda kerakli ma'lumot topilmadi.",
  3: "Terminal band — biroz kutib qayta urinib ko'ring.",
  4: "Terminalga ruxsat berilmadi. Login/parolni tekshiring.",
  5: "So'rov formati noto'g'ri.",
  6: "Yuborilgan ma'lumot (rasm) terminal talabiga mos emas.",
  7: "Terminal ichki xatoligi. Birozdan so'ng qayta urinib ko'ring.",
};

/**
 * Hikvision xatoligini foydalanuvchiga ko'rsatsa bo'ladigan
 * tushunarli matnga aylantiradi. Hech narsa mos kelmasa,
 * umumiy "qayta urinib ko'ring" xabarini qaytaradi.
 */
export function translateHikvisionError(err: HikvisionErrorShape): string {
  if (err.subStatusCode && SUB_STATUS_MESSAGES[err.subStatusCode]) {
    return SUB_STATUS_MESSAGES[err.subStatusCode];
  }

  if (
    typeof err.statusCode === 'number' &&
    STATUS_CODE_MESSAGES[err.statusCode]
  ) {
    return STATUS_CODE_MESSAGES[err.statusCode];
  }

  // Hech qanday tanish kod topilmasa — umumiy, lekin baribir
  // tushunarli xabar (texnik kodlarsiz)
  return "Rasmni terminalga yuklab bo'lmadi. Rasm sifati yoki formati mos kelmagan bo'lishi mumkin — boshqa rasm bilan qayta urinib ko'ring.";
}

/**
 * Hikvision API'dan kelgan xato javobini (HTTP 400 body) shu shaklga
 * moslab, keyin translateHikvisionError'ga uzatish uchun yordamchi.
 * hikvision.service.ts ichida catch(err) qismida ishlatiladi.
 *
 * Misol:
 *   try {
 *     await axios.post(url, data);
 *   } catch (err: any) {
 *     const body = err.response?.data; // Hikvision JSON javobi
 *     const friendly = translateHikvisionError(body ?? {});
 *     throw new BadRequestException(friendly);
 *   }
 */
export function parseHikvisionErrorBody(raw: unknown): HikvisionErrorShape {
  if (raw && typeof raw === 'object') {
    return raw as HikvisionErrorShape;
  }
  return {};
}