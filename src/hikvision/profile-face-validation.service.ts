import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import sharp from 'sharp';
import { createHash } from 'crypto';

const NO_FACE =
  'Rasmda yuz aniqlanmadi. Xodimning yuzi aniq ko‘rinadigan, old tomondan olingan suratni yuklang. Daraxt, hujjat yoki boshqa yuzsiz rasmlar qabul qilinmaydi.';
const MANY_FACES =
  'Rasmda bir nechta yuz aniqlandi. Faqat shu xodimning bitta yuzi tushirilgan suratni yuklang.';
const UNAVAILABLE =
  'Yuzni tekshirish xizmati hozir javob bermayapti. Rasm saqlanmadi va terminalga yuborilmadi. Birozdan so‘ng qayta urinib ko‘ring.';

/** Presence only; no identity matching, external services or image persistence. */
@Injectable()
export class ProfileFaceValidationService {
  private readonly cache = new Map<
    string,
    { count: number; expires: number }
  >();
  private readonly pending = new Map<string, Promise<number>>();

  async assertFace(buffer: Buffer): Promise<void> {
    const key = createHash('sha256').update(buffer).digest('hex');
    const hit = this.cache.get(key);
    let count: number;
    if (hit && hit.expires > Date.now()) count = hit.count;
    else {
      let work = this.pending.get(key);
      if (!work) {
        if (this.pending.size >= 3)
          throw new ServiceUnavailableException(UNAVAILABLE);
        work = this.detect(buffer).then((count) => {
          if (this.cache.size >= 256)
            this.cache.delete(this.cache.keys().next().value);
          this.cache.set(key, { count, expires: Date.now() + 30 * 60 * 1000 });
          return count;
        });
        this.pending.set(key, work);
      }
      try {
        count = await work;
      } finally {
        this.pending.delete(key);
      }
    }
    if (count === 0) throw new BadRequestException(NO_FACE);
    if (count !== 1) throw new BadRequestException(MANY_FACES);
  }
  private async detect(buffer: Buffer): Promise<number> {
    let normalized: Buffer;
    try {
      normalized = await sharp(buffer, { limitInputPixels: 32_000_000 })
        .rotate()
        .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw new BadRequestException(
        'Rasmni o‘qib bo‘lmadi. JPG yoki PNG formatidagi aniq suratni qayta yuklang.',
      );
    }
    try {
      const { data } = await axios.post(
        `${process.env.FACE_MATCH_SERVICE_URL || 'http://face-match:8000'}/detect`,
        { image: normalized.toString('base64') },
        { timeout: 15000, maxBodyLength: 2_000_000 },
      );
      if (!Number.isInteger(data?.faceCount) || data.faceCount < 0)
        throw Error('INVALID_RESPONSE');
      return data.faceCount;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400)
        throw new BadRequestException(
          'Rasmni tahlil qilib bo‘lmadi. Yuz aniq ko‘rinadigan boshqa JPG yoki PNG suratni yuklang.',
        );
      // Never log Axios errors: config/data contain the submitted image.
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
  }
}
