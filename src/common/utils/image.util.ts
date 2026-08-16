// eslint-disable-next-line @typescript-eslint/no-var-requires
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Rasmni qayta ishlaydi:
 * - EXIF orientatsiyasiga qarab avtomatik to'g'ri buradi (yonboshlab qolmaydi)
 * - Maksimal 800x800 ga resize qiladi (nisbatni saqlaydi, kichiklashtirmaydi)
 * - JPEG 85% sifatda siqadi
 * - Disk hajmini ~70-80% kamaytiradi
 */
export async function processAndSavePhoto(
  buffer: Buffer,
  uploadDir: string,
  filenameWithoutExt: string,
): Promise<{ filename: string; sizeKb: number }> {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filename = `${filenameWithoutExt}.jpg`;
  const outputPath = path.join(uploadDir, filename);

  await sharp(buffer)
    .rotate() // EXIF orientatsiyasini avtomatik to'g'rilaydi
    .resize(800, 800, {
      fit: 'inside', // Nisbatni saqlaydi
      withoutEnlargement: true, // Kichik rasmlarni kattalashtirmaydi
    })
    .jpeg({ quality: 85, progressive: true, mozjpeg: false })
    .toFile(outputPath);

  const stat = fs.statSync(outputPath);
  return { filename, sizeKb: Math.round(stat.size / 1024) };
}
