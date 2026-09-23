import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Bitta muassasada HR botga ulanishi mumkin bo'lgan shaxslar soni. */
export const MAX_BOT_ACCESS_PER_HOSPITAL = 5;

/** Telefon raqamidan faqat oxirgi 9 raqam (O'zbekiston: operator kodi + raqam). */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
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
}
