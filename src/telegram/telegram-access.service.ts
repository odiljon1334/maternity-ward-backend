import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** Bitta muassasada HR botga ulanishi mumkin bo'lgan shaxslar soni. */
export const MAX_BOT_ACCESS_PER_HOSPITAL = 5;

/** Telefon raqamidan faqat oxirgi 9 raqam (O'zbekiston: operator kodi + raqam). */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Mobil ilova beradigan ulanish havolasining amal qilish muddati */
export const LINK_TOKEN_TTL_MS = 15 * 60_000;
/** Deep-link payload prefiksi: t.me/<bot>?start=L_<token> */
export const LINK_PAYLOAD_PREFIX = 'L_';

export const hashLinkToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface PersonalLink {
  employeeId: string;
  fullName: string;
  hospitalName: string;
}

export interface BotLinkCandidate {
  employeeId: string;
  fullName: string;
  hospitalId: string;
  hospitalName: string;
}

/**
 * HR botga kim ulana olishini boshqaradi (allowlist).
 *
 * Xavfsizlik modeli (2026-09-23 audit):
 *  - Ro'yxatga faqat Direktor/Admin/Assistant Admin/Super Admin xodim
 *    qo'shadi (bir muassasada ko'pi bilan MAX_BOT_ACCESS_PER_HOSPITAL).
 *  - Ulanish faqat Telegram "raqamni ulashish" orqali: raqamni Telegram o'zi
 *    beradi va `contact.user_id === from.id` tekshiriladi — boshqa odamning
 *    raqamini yozib ulanib bo'lmaydi.
 */
@Injectable()
export class TelegramAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async list(hospitalId: string) {
    const [granted, legacy] = await Promise.all([
      this.prisma.employee.findMany({
        where: { hospitalId, telegramBotAccess: true },
        select: {
          id: true,
          fullName: true,
          phone: true,
          firedAt: true,
          position: { select: { name: true } },
          telegramSubs: {
            where: { isActive: true },
            select: { id: true, username: true, createdAt: true },
          },
        },
        orderBy: { fullName: 'asc' },
      }),
      // Eski usulda (raqamni matn bilan yozib) ulangan, egasi noma'lum chatlar
      this.prisma.telegramSubscription.findMany({
        where: { hospitalId, isActive: true, employeeId: null },
        select: { id: true, username: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      limit: MAX_BOT_ACCESS_PER_HOSPITAL,
      granted: granted.map((e) => ({
        employeeId: e.id,
        fullName: e.fullName,
        position: e.position?.name ?? null,
        phone: e.phone,
        hasValidPhone: phoneKey(e.phone) !== null,
        isFired: e.firedAt !== null,
        linkedChats: e.telegramSubs,
      })),
      legacyChats: legacy,
    };
  }

  async setAccess(hospitalId: string, employeeId: string, enabled: boolean) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, hospitalId },
      select: {
        id: true,
        phone: true,
        firedAt: true,
        telegramBotAccess: true,
      },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');

    if (!enabled) {
      await this.prisma.$transaction([
        this.prisma.employee.update({
          where: { id: employee.id },
          data: { telegramBotAccess: false },
        }),
        this.prisma.telegramSubscription.updateMany({
          where: { employeeId: employee.id, isActive: true },
          data: { isActive: false },
        }),
      ]);
      return { employeeId: employee.id, enabled: false };
    }

    if (employee.telegramBotAccess) {
      return { employeeId: employee.id, enabled: true };
    }
    if (employee.firedAt) {
      throw new BadRequestException(
        "Ishdan bo'shagan xodimga ruxsat berilmaydi",
      );
    }
    if (!phoneKey(employee.phone)) {
      throw new BadRequestException(
        "Xodimning telefon raqami kiritilmagan yoki noto'g'ri. Avval xodim kartasida raqamni to'g'rilang.",
      );
    }
    const count = await this.prisma.employee.count({
      where: { hospitalId, telegramBotAccess: true, firedAt: null },
    });
    if (count >= MAX_BOT_ACCESS_PER_HOSPITAL) {
      throw new BadRequestException(
        `Bitta muassasada ko'pi bilan ${MAX_BOT_ACCESS_PER_HOSPITAL} kishiga ruxsat beriladi. Avval kimningdir ruxsatini olib tashlang.`,
      );
    }

    await this.prisma.employee.update({
      where: { id: employee.id },
      data: { telegramBotAccess: true },
    });
    return { employeeId: employee.id, enabled: true };
  }

  /** Bitta chat ulanishini uzish (masalan, eski usulda ulangan noma'lum chat). */
  async revokeSubscription(hospitalId: string, subscriptionId: string) {
    const result = await this.prisma.telegramSubscription.updateMany({
      where: { id: subscriptionId, hospitalId, isActive: true },
      data: { isActive: false },
    });
    if (result.count === 0) throw new NotFoundException('Ulanish topilmadi');
    return { revoked: true };
  }

  /** Tasdiqlangan telefon raqamiga mos, ruxsati bor faol xodimlar. */
  async findLinkCandidates(phone: string): Promise<BotLinkCandidate[]> {
    const key = phoneKey(phone);
    if (!key) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Employee"
      WHERE "firedAt" IS NULL
        AND "telegramBotAccess" = true
        AND phone IS NOT NULL
        AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key}
    `;
    if (!rows.length) return [];
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: {
        id: true,
        fullName: true,
        hospitalId: true,
        hospital: { select: { name: true } },
      },
      orderBy: { fullName: 'asc' },
    });
    return employees.map((e) => ({
      employeeId: e.id,
      fullName: e.fullName,
      hospitalId: e.hospitalId,
      hospitalName: e.hospital?.name ?? '—',
    }));
  }

  /** Chatni tasdiqlangan xodim nomidan muassasaga ulaydi. */
  async linkChat(
    chatId: string,
    username: string,
    candidate: BotLinkCandidate,
  ) {
    // Ulanish paytida ruxsat hali ham borligini qayta tekshiramiz
    const stillAllowed = await this.prisma.employee.count({
      where: {
        id: candidate.employeeId,
        hospitalId: candidate.hospitalId,
        telegramBotAccess: true,
        firedAt: null,
      },
    });
    if (!stillAllowed) return false;

    await this.prisma.telegramSubscription.upsert({
      where: {
        chatId_hospitalId: { chatId, hospitalId: candidate.hospitalId },
      },
      update: { isActive: true, username, employeeId: candidate.employeeId },
      create: {
        chatId,
        username,
        role: 'DIRECTOR',
        hospitalId: candidate.hospitalId,
        employeeId: candidate.employeeId,
        isActive: true,
      },
    });
    return true;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shaxsiy ulanish (har bir xodim o'zi uchun: eslatmalar, kelish/ketish)
  // Rahbarlar HR-obunasidan (TelegramSubscription) alohida — bu yerda faqat
  // Employee.telegramChatId yoziladi.
  // ────────────────────────────────────────────────────────────────────────

  /** Bir martalik ulanish tokeni (base64url, 24 belgi — Telegram 64 gacha ruxsat beradi) */
  async createLinkToken(employeeId: string) {
    const token = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
    // Eski ishlatilmagan tokenlar bekor qilinadi — bir vaqtda bitta havola
    await this.prisma.telegramLinkToken.deleteMany({
      where: { employeeId, usedAt: null },
    });
    await this.prisma.telegramLinkToken.create({
      data: { tokenHash: hashLinkToken(token), employeeId, expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * Tokenni ishlatadi va chatni xodimga bog'laydi. Token bir marta ishlaydi:
   * `updateMany … usedAt: null` — ikki parallel /start dan faqat bittasi o'tadi.
   */
  async consumeLinkToken(
    token: string,
    chatId: string,
  ): Promise<PersonalLink | 'expired' | 'invalid'> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return 'invalid';
    const row = await this.prisma.telegramLinkToken.findUnique({
      where: { tokenHash: hashLinkToken(token) },
      include: {
        employee: {
          select: {
            id: true,
            fullName: true,
            firedAt: true,
            hospital: { select: { name: true } },
          },
        },
      },
    });
    if (!row || row.usedAt || row.employee.firedAt) return 'invalid';
    if (row.expiresAt.getTime() < Date.now()) return 'expired';

    const claimed = await this.prisma.telegramLinkToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) return 'invalid';

    await this.prisma.employee.update({
      where: { id: row.employeeId },
      data: {
        telegramChatId: chatId,
        telegramLinkedAt: new Date(),
        telegramReminders: true,
      },
    });
    return {
      employeeId: row.employee.id,
      fullName: row.employee.fullName,
      hospitalName: row.employee.hospital?.name ?? '—',
    };
  }

  /**
   * Telegram tasdiqlagan raqam bo'yicha barcha faol xodim profillari
   * (bitta odam ikki muassasada ishlashi mumkin) — hammasi shu chatga
   * bog'lanadi. Rahbar ruxsati (`telegramBotAccess`) talab qilinmaydi.
   */
  async linkPersonalByPhone(
    phone: string,
    chatId: string,
  ): Promise<PersonalLink[]> {
    const key = phoneKey(phone);
    if (!key) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Employee"
      WHERE "firedAt" IS NULL
        AND phone IS NOT NULL
        AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${key}
    `;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    await this.prisma.employee.updateMany({
      where: { id: { in: ids } },
      data: {
        telegramChatId: chatId,
        telegramLinkedAt: new Date(),
        telegramReminders: true,
      },
    });
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        fullName: true,
        hospital: { select: { name: true } },
      },
    });
    return employees.map((e) => ({
      employeeId: e.id,
      fullName: e.fullName,
      hospitalName: e.hospital?.name ?? '—',
    }));
  }

  /** Chatga bog'langan xodim profillari (faol) */
  personalLinksOf(chatId: string) {
    return this.prisma.employee.findMany({
      where: { telegramChatId: chatId, firedAt: null },
      select: {
        id: true,
        fullName: true,
        hospitalId: true,
        telegramReminders: true,
        hospital: { select: { name: true } },
      },
    });
  }

  async unlinkPersonal(where: { employeeId?: string; chatId?: string }) {
    if (!where.employeeId && !where.chatId) return 0;
    const r = await this.prisma.employee.updateMany({
      where: where.employeeId
        ? { id: where.employeeId }
        : { telegramChatId: where.chatId },
      data: { telegramChatId: null, telegramLinkedAt: null },
    });
    return r.count;
  }

  async setReminders(
    where: { employeeId?: string; chatId?: string },
    enabled: boolean,
  ) {
    if (!where.employeeId && !where.chatId) return 0;
    const r = await this.prisma.employee.updateMany({
      where: where.employeeId
        ? { id: where.employeeId }
        : { telegramChatId: where.chatId },
      data: { telegramReminders: enabled },
    });
    return r.count;
  }
}
