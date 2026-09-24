import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { hostname } from 'os';

type RawDb = {
  $executeRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<number>;
};

const INSTANCE = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const fallbackLogger = new Logger('CronLock');

/**
 * `name` qulfini `ttlMs` muddatga egallashga urinadi. Egallab bo'lmasa
 * (boshqa nusxa yoki shu vazifaning oldingi ishga tushishi hali ishlayapti)
 * `fn` chaqirilmaydi va `undefined` qaytadi.
 *
 * Lease modeli: qulf egasi o'lib qolsa ham `lockedUntil` o'tgach qulf
 * bo'shaydi — hech narsa abadiy qotib qolmaydi. Tugagach qulf kamida 50
 * soniya ushlab turiladi: boshqa nusxa ayni shu daqiqada ishga tushsa, u
 * tez tugagan vazifani (masalan kunlik hisobotni) ikkinchi marta bajarmaydi.
 * Keyingi daqiqadagi ishga tushish esa odatdagidek o'tadi.
 */
export async function runWithCronLock<T>(
  db: RawDb,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
  logger: {
    warn: (m: string) => void;
    debug?: (m: string) => void;
  } = fallbackLogger,
): Promise<T | undefined> {
  const owner = `${INSTANCE}:${randomUUID().slice(0, 8)}`;
  const ttl = Math.max(1_000, Math.floor(ttlMs));
  let acquired = 0;
  try {
    acquired = await db.$executeRaw`
      INSERT INTO "CronLock" ("name", "owner", "lockedUntil", "updatedAt")
      VALUES (${name}, ${owner}, now() + (${ttl} * interval '1 millisecond'), now())
      ON CONFLICT ("name") DO UPDATE
        SET "owner" = EXCLUDED."owner",
            "lockedUntil" = EXCLUDED."lockedUntil",
            "updatedAt" = now()
        WHERE "CronLock"."lockedUntil" < now()`;
  } catch (e) {
    logger.warn(
      `Cron qulfi olinmadi (${name}): ${e instanceof Error ? e.message : String(e)} — vazifa o'tkazib yuborildi`,
    );
    return undefined;
  }
  if (acquired < 1) {
    logger.debug?.(`Cron ${name}: boshqa nusxada ishlayapti — o'tkazildi`);
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await db.$executeRaw`
      UPDATE "CronLock"
      SET "lockedUntil" = GREATEST(now(), "updatedAt" + interval '50 seconds')
      WHERE "name" = ${name} AND "owner" = ${owner}`.catch(() => undefined);
  }
}

/**
 * Metod dekoratori — `@Cron(...)` DAN PASTDA yoziladi (avval u qo'llanadi,
 * so'ng @Cron metadata'ni yangi funksiyaga qo'yadi). Klassda `prisma`
 * (PrismaService) bo'lishi kerak.
 */
export function CronLock(name: string, ttlMs = 10 * 60_000): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...a: unknown[]) => Promise<unknown>;
    const wrapped = async function (this: any, ...args: unknown[]) {
      const db: RawDb | undefined = this?.prisma;
      if (!db?.$executeRaw) return original.apply(this, args);
      return runWithCronLock(
        db,
        name,
        ttlMs,
        () => original.apply(this, args),
        this?.logger,
      );
    };
    // Oldin qo'yilgan metadata (bo'lsa) yo'qolmasin
    for (const key of Reflect.getMetadataKeys?.(original) ?? []) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapped);
    }
    Object.defineProperty(wrapped, 'name', { value: original.name });
    descriptor.value = wrapped;
    return descriptor;
  };
}
