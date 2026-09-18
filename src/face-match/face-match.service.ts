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
 * FAIL-OPEN siyosati (standart, FACE_MATCH_MODE=lenient):
 *   Bu YANGI, IXTIYORIY qatlam — production check-in oqimini
 *   to'xtatmasligi kerak. Shuning uchun quyidagi hollarda check-in
 *   BLOKLANMAYDI (faqat log yoziladi):
 *     - Xodimning profil rasmi mavjud emas (solishtirish uchun narsa yo'q)
 *     - Face-match mikroservisi ishlamayapti / javob bermadi / xato qaytardi
 *     - Rasmlardan birida yuz aniqlanmadi (yomon burchak/yorug'lik bo'lishi mumkin)
 *
 * FACE_MATCH_MODE=strict bo'lsa — yuqoridagi "yuz aniqlanmadi" va
 * "xizmat ishlamadi" holatlari ham bloklaydi.
 *
 * ANIQ MOS KELMASLIK (ikkala rasmda ham yuz topilgan, lekin bir xil
 * odam emas) — MODE'dan qat'iy nazar HAR DOIM bloklaydi. Bu qatlamning
 * butun maqsadi shu — fail-open faqat "aniqlab bo'lmadi" holatlariga tegishli,
 * "aniq mos kelmaydi" holatiga emas.
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
    return (process.env.FACE_MATCH_MODE || 'lenient') as 'lenient' | 'strict';
  }
  private get serviceUrl(): string {
    return process.env.FACE_MATCH_SERVICE_URL || 'http://face-match:8000';
  }
  private get threshold(): number {
    return Number(process.env.FACE_MATCH_THRESHOLD || 0.36);
  }
  private get timeoutMs(): number {
    return Number(process.env.FACE_MATCH_TIMEOUT_MS || 6000);
  }

  async verify(
    referenceBuffer: Buffer | null,
    liveBuffer: Buffer,
  ): Promise<FaceMatchResult> {
    if (!this.enabled) {
      return { skipped: true, mismatch: false, reason: 'DISABLED' };
    }
    if (!referenceBuffer) {
      return { skipped: true, mismatch: false, reason: 'NO_REFERENCE_PHOTO' };
    }

    const MODE = this.mode;
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
