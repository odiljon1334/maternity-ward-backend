import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs';
import type { Request, Response, NextFunction } from 'express';

/**
 * Ro'yxatlarda ko'rsatiladigan avatar o'lchami.
 * Asl rasm 800x800 (~60-120 KB) — 350 ta xodim ro'yxatida bu 20-40 MB.
 * 128x128 thumbnail esa ~4-6 KB → sahifa ~10 barobar tez ochiladi.
 */
const THUMB_SIZE = 128;
const THUMB_QUALITY = 78;

/** Thumbnail'lar saqlanadigan papka nomi (uploads ichida) */
export const THUMB_DIR_NAME = '.thumbs';

/** Bir vaqtda bir xil faylni ikki marta generatsiya qilmaslik uchun */
const inFlight = new Map<string, Promise<string | null>>();

async function generateThumb(
  sourcePath: string,
  thumbPath: string,
): Promise<string | null> {
  try {
    await fs.promises.mkdir(path.dirname(thumbPath), { recursive: true });
    await sharp(sourcePath)
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: THUMB_QUALITY, progressive: false })
      .toFile(thumbPath);
    return thumbPath;
  } catch {
    // Buzuq rasm / qo'llab-quvvatlanmaydigan format — asl faylga qaytamiz
    return null;
  }
}

/**
 * `/uploads/thumb/<fayl>` uchun Express middleware.
 *
 * Ishlash tartibi:
 *   1. `uploads/.thumbs/<fayl>.jpg` mavjud bo'lsa — darhol beriladi
 *   2. Bo'lmasa — asl `uploads/<fayl>` dan generatsiya qilinadi va saqlanadi
 *   3. Asl fayl ham topilmasa — 404
 *
 * Mavjud rasmlar uchun migratsiya kerak emas: thumbnail birinchi
 * so'rovda o'zi yaratiladi (lazy).
 */
export function thumbnailMiddleware(uploadDir: string) {
  return function thumbnailHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // ⚠️ Path traversal himoyasi — faqat fayl nomi olinadi
    const raw = decodeURIComponent(req.path.replace(/^\/+/, ''));
    const filename = path.basename(raw);
    if (!filename || filename.startsWith('.')) return next();

    const sourcePath = path.join(uploadDir, filename);
    const thumbPath = path.join(
      uploadDir,
      THUMB_DIR_NAME,
      `${path.parse(filename).name}.jpg`,
    );

    const send = (filePath: string) => {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      res.sendFile(path.resolve(filePath));
    };

    if (fs.existsSync(thumbPath)) return send(thumbPath);
    if (!fs.existsSync(sourcePath)) return next();

    let task = inFlight.get(thumbPath);
    if (!task) {
      task = generateThumb(sourcePath, thumbPath).finally(() => {
        inFlight.delete(thumbPath);
      });
      inFlight.set(thumbPath, task);
    }

    task
      .then((result) => send(result ?? sourcePath))
      .catch(() => send(sourcePath));
  };
}
