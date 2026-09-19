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

/**
 * Shifoxona logotipini qayta ishlaydi va saqlaydi (tenant branding self-service,
 * 2026-09-19). Xodim rasmidan (`processAndSavePhoto`) farqi — logotiplar ko'pincha
 * shaffof fonli (PNG) bo'ladi, shuning uchun JPEG'ga MAJBURAN aylantirilmaydi
 * (shaffoflik yo'qolmasligi uchun), aksincha har doim PNG sifatida saqlanadi
 * (kirish formati JPG bo'lsa ham — muammosiz, faqat biroz kattaroq fayl bo'lishi
 * mumkin, lekin logotip hajmi juda kichik bo'lgani uchun bu ahamiyatsiz).
 * Maksimal 512x512 (nisbatni saqlab, kattalashtirmasdan).
 */
export async function processAndSaveLogo(
  buffer: Buffer,
  uploadDir: string,
  filenameWithoutExt: string,
): Promise<{ filename: string; sizeKb: number }> {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filename = `${filenameWithoutExt}.png`;
  const outputPath = path.join(uploadDir, filename);

  await sharp(buffer)
    .rotate()
    .resize(512, 512, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ quality: 90 })
    .toFile(outputPath);

  const stat = fs.statSync(outputPath);
  return { filename, sizeKb: Math.round(stat.size / 1024) };
}
