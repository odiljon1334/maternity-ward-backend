import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { memoryStorage } from 'multer';

const MB = 1024 * 1024;

/**
 * Fayl yuklash cheklovlari. Ilgari ko'p endpointlarda hajm chegarasi yo'q edi
 * (memoryStorage — butun fayl RAM'ga o'qiladi): bitta katta so'rov
 * backendni xotirasiz qoldirishi mumkin edi.
 */
export function imageUpload(maxMb: number): MulterOptions {
  return {
    storage: memoryStorage(),
    limits: { fileSize: maxMb * MB, files: 1, fields: 20 },
    fileFilter: (_req, file, cb) => {
      // Ba'zi mobil brauzerlar blob'ni octet-stream deb yuboradi — mazmuni
      // baribir sharp orqali tekshiriladi (rasm bo'lmasa xato beradi)
      const ok =
        /^image\/(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.mimetype) ||
        file.mimetype === 'application/octet-stream';
      if (!ok) {
        return cb(
          new BadRequestException(
            'Faqat rasm fayli yuklash mumkin (JPG, PNG, WEBP)',
          ),
          false,
        );
      }
      cb(null, true);
    },
  };
}

export function spreadsheetUpload(maxMb: number): MulterOptions {
  return {
    storage: memoryStorage(),
    limits: { fileSize: maxMb * MB, files: 1, fields: 20 },
    fileFilter: (_req, file, cb) => {
      const name = String(file.originalname || '').toLowerCase();
      const ok =
        /\.(xlsx|xls|csv)$/.test(name) ||
        /spreadsheetml|ms-excel|text\/csv|application\/octet-stream/.test(
          file.mimetype,
        );
      if (!ok) {
        return cb(
          new BadRequestException('Faqat Excel (.xlsx) yoki CSV fayl'),
          false,
        );
      }
      cb(null, true);
    },
  };
}
