import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface FaceMatchResult {
  /** true = solishtirish o'tkazildi va YUZLAR MOS KELMADI — check-in bloklanishi kerak */
  mismatch: boolean;
  /** true = tekshiruv o'tkazilmadi (xizmat ishlamayapti / rasm yo'q / yuz topilmadi) — fail-open holat */
  skipped: boolean;
  reason?: string;
  similarity?: number;
}

/**
 * Check-in selfie'sini xodimning profil rasmi bilan solishtiradi
 * (o'z serverimizdagi InsightFace mikroservisi orqali — Qaror 4).
 *
 * FAIL-CLOSED siyosati (standart, FACE_MATCH_MODE=strict):
 *   Qaror 4'ning butun maqsadi — yuz tasdiqlanmasa davomat qayd etilmasin.
 *   Shuning uchun quyidagi HAMMA holatlarda check-in BLOKLANADI:
 *     - Xodimning profil rasmi mavjud emas (solishtirish uchun narsa yo'q)
 *     - Face-match mikroservisi ishlamayapti / javob bermadi / xato qaytardi
 *     - Rasmlardan birida yuz aniqlanmadi (qorong'u joy, yomon burchak va h.k.)
 *     - Aniq mos kelmaslik (ikkala rasmda ham yuz topilgan, lekin bir xil odam emas)
 *
 * FACE_MATCH_MODE=lenient qo'yilsa (faqat maxsus holatlar uchun, masalan
 * face-match xizmati hali sozlanmagan bosqichda) — yuqoridagi birinchi uchta
 * "aniqlab bo'lmadi" holati check-in'ni BLOKLAMAYDI, faqat log yoziladi.
 * DIQQAT: lenient rejimda ham ANIQ MOS KELMASLIK har doim bloklaydi.
 */
@Injectable()
export class FaceMatchService {
  private readonly logger = new Logger(FaceMatchService.name);

  // process.env har chaqiruvda o'qiladi (module-load vaqtida emas) —
  // shunda testlarda va runtime'da ENV o'zgarishi darhol ta'sir qiladi.
  private get enabled(): boolean {
    return process.env.FACE_MATCH_ENABLED !== 'false'; // standart: yoqilgan
  }
  private get mode(): 'lenient' | 'strict' {
    return (process.env.FACE_MATCH_MODE || 'strict') as 'lenient' | 'strict';
  }
  private get serviceUrl(): string {
    return process.env.FACE_MATCH_SERVICE_URL || 'http://face-match:8000';
  }
  private get threshold(): number {
    return Number(process.env.FACE_MATCH_THRESHOLD || 0.36);
  }
  private get timeoutMs(): number {
    // Startup warm-up asosiy yechim, 15 soniya esa model ishlayotgan paytdagi
    // CPU yuklamasi uchun xavfsiz minimal zaxira. Eski .env.prod dagi 6000
    // qiymati ham shu bilan xavfsiz ko'tariladi; kattaroq qiymat berish mumkin.
    return Math.max(Number(process.env.FACE_MATCH_TIMEOUT_MS || 15000), 15000);
  }

  async verify(
    referenceBuffer: Buffer | null,
    liveBuffer: Buffer,
  ): Promise<FaceMatchResult> {
    if (!this.enabled) {
      return { skipped: true, mismatch: false, reason: 'DISABLED' };
    }
    const MODE = this.mode;
    if (!referenceBuffer) {
      if (MODE === 'strict') {
        this.logger.warn(
          "Face-match: xodimning profil rasmi yo'q (NO_REFERENCE_PHOTO) — strict rejim, check-in bloklandi",
        );
        return { skipped: false, mismatch: true, reason: 'NO_REFERENCE_PHOTO' };
      }
      return { skipped: true, mismatch: false, reason: 'NO_REFERENCE_PHOTO' };
    }

    const SERVICE_URL = this.serviceUrl;

    let data: any;
    try {
      const res = await axios.post(
        `${SERVICE_URL}/verify`,
        {
          reference_image: referenceBuffer.toString('base64'),
          live_image: liveBuffer.toString('base64'),
          threshold: this.threshold,
        },
        { timeout: this.timeoutMs },
      );
      data = res.data;
    } catch (e: any) {
      // 400 — xizmat ishlayapti, lekin rasmni o'qiy olmadi (rasmlar oldindan
      // qayta kodlanadi, demak muammo jonli suratda). Buni "xizmat ishlamadi"
      // deb hisoblash xavfli: SERVICE_ERROR check-in'da kechiktiriladi va
      // yuz tekshiruvini chetlab o'tish yo'li bo'lib qolardi.
      if (e?.response?.status === 400) {
        this.logger.warn(
          `Face-match: rasm o'qilmadi (HTTP 400) — ${JSON.stringify(e.response.data ?? '').slice(0, 200)}`,
        );
        return MODE === 'strict'
          ? { skipped: false, mismatch: true, reason: 'LIVE_FACE_NOT_FOUND' }
          : { skipped: true, mismatch: false, reason: 'LIVE_FACE_NOT_FOUND' };
      }
      this.logger.warn(
        `Face-match xizmati ishlamadi (${SERVICE_URL}): ${e?.message ?? e}`,
      );
      if (MODE === 'strict') {
        return { skipped: false, mismatch: true, reason: 'SERVICE_ERROR' };
      }
      return { skipped: true, mismatch: false, reason: 'SERVICE_ERROR' };
    }

    if (!data?.referenceFaceFound || !data?.liveFaceFound) {
      const reason = !data?.liveFaceFound
        ? 'LIVE_FACE_NOT_FOUND'
        : 'REFERENCE_FACE_NOT_FOUND';
      if (MODE === 'strict') {
        return { skipped: false, mismatch: true, reason };
      }
      this.logger.warn(
        `Face-match: yuz aniqlanmadi (${reason}) — lenient rejim, check-in o'tkazib yuborildi`,
      );
      return { skipped: true, mismatch: false, reason };
    }

    if (!data.match) {
      this.logger.warn(
        `Face-match: MOS KELMADI (similarity=${data.similarity}, threshold=${this.threshold})`,
      );
      return {
        skipped: false,
        mismatch: true,
        reason: 'FACE_MISMATCH',
        similarity: data.similarity,
      };
    }

    return { skipped: false, mismatch: false, similarity: data.similarity };
  }
}
