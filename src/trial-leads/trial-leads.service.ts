import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TrialLeadSource, TrialLeadStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryTrialLeadsDto } from './dto/query-trial-leads.dto';

export type CaptureTrialLeadInput = {
  source: TrialLeadSource;
  institutionName: string;
  contactName: string;
  phone: string;
  orgType?: string | null;
  region?: string | null;
  staffCount?: number | null;
  plan?: string | null;
  billingCycle?: string | null;
  faceId?: boolean | null;
  contactTime?: string | null;
  telegramChatId?: string | null;
  telegramUsername?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  pageUrl?: string | null;
};

export type CaptureTelegramContactInput = {
  chatId: string;
  username?: string | null;
  displayName: string;
  firstMessage: string;
};

export type CompleteTelegramLeadInput = Omit<
  CaptureTrialLeadInput,
  'source' | 'telegramChatId' | 'telegramUsername'
> & {
  chatId: string;
  username?: string | null;
};

/**
 * O'zbekiston raqamini bitta ko'rinishga keltiradi: "+998 90 123-45-67",
 * "901234567", "998901234567" → "+998901234567". Boshqa formatlar o'zgarmaydi.
 */
export function normalizeUzPhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return trimmed;
}

/** Shu muddat ichida xuddi shu raqamdan kelgan ochiq lead takroriy hisoblanadi */
const DUPLICATE_WINDOW_DAYS = 30;

@Injectable()
export class TrialLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Veb-forma leadini saqlaydi. Shu raqamdan oxirgi 30 kunda ochiq (yopilmagan)
   * lead bo'lsa, yangisi yaratilmaydi — mavjudi yangi ma'lumot bilan to'ldiriladi
   * va izohga takroriy so'rov qayd etiladi.
   */
  async capture(
    input: CaptureTrialLeadInput,
  ): Promise<{ lead: { id: string }; duplicate: boolean }> {
    const phone = normalizeUzPhone(input.phone);
    const since = new Date(
      Date.now() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const existing = await this.prisma.trialLead.findFirst({
      where: {
        phone,
        createdAt: { gte: since },
        status: {
          notIn: [TrialLeadStatus.CONVERTED, TrialLeadStatus.REJECTED],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, note: true },
    });

    if (!existing) {
      const lead = await this.prisma.trialLead.create({
        data: { ...input, phone },
      });
      return { lead, duplicate: false };
    }

    const filled = Object.fromEntries(
      Object.entries({ ...input, phone }).filter(
        ([, value]) => value !== undefined && value !== null && value !== '',
      ),
    );
    const stamp = new Date().toLocaleString('uz-UZ', {
      timeZone: 'Asia/Tashkent',
    });
    const note = [existing.note, `Takroriy so'rov: ${stamp}`]
      .filter(Boolean)
      .join('\n')
      .slice(-1000);
    const lead = await this.prisma.trialLead.update({
      where: { id: existing.id },
      data: { ...filled, note },
    });
    return { lead, duplicate: true };
  }

  /** Birinchi Telegram xabaridayoq LEAD yaratadi, takroriy xabarda dublikat qilmaydi. */
  async captureTelegramContact(input: CaptureTelegramContactInput) {
    const existing = await this.prisma.trialLead.findFirst({
      where: {
        source: TrialLeadSource.TELEGRAM_BOT,
        telegramChatId: input.chatId,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      if (input.username && input.username !== existing.telegramUsername) {
        const lead = await this.prisma.trialLead.update({
          where: { id: existing.id },
          data: { telegramUsername: input.username },
        });
        return { lead, created: false };
      }
      return { lead: existing, created: false };
    }

    const message = input.firstMessage.trim().slice(0, 1000);
    const lead = await this.prisma.trialLead.create({
      data: {
        source: TrialLeadSource.TELEGRAM_BOT,
        institutionName: 'Telegram orqali murojaat',
        contactName: input.displayName.trim() || "Noma'lum Telegram mijoz",
        phone: 'Kiritilmagan',
        telegramChatId: input.chatId,
        telegramUsername: input.username || null,
        note: message ? `Birinchi xabar: ${message}` : null,
      },
    });
    return { lead, created: true };
  }

  /** Trial anketasi tugaganda dastlabki Telegram LEADni to'liq ma'lumot bilan boyitadi. */
  async completeTelegramLead(input: CompleteTelegramLeadInput) {
    const existing = await this.prisma.trialLead.findFirst({
      where: {
        source: TrialLeadSource.TELEGRAM_BOT,
        telegramChatId: input.chatId,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const { chatId, username, ...details } = input;
    const data = {
      ...details,
      telegramChatId: chatId,
      telegramUsername: username || null,
    };

    if (existing) {
      return this.prisma.trialLead.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.trialLead.create({
      data: { source: TrialLeadSource.TELEGRAM_BOT, ...data },
    });
  }

  async findAll(query: QueryTrialLeadsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim();
    // "90 123 45 67" kabi bo'shliqli qidiruv saqlangan +998901234567 ga mos kelsin
    const searchDigits = search?.replace(/\D/g, '') ?? '';
    const where: Prisma.TrialLeadWhereInput = {
      ...(query.source ? { source: query.source } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { institutionName: { contains: search, mode: 'insensitive' } },
              { contactName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              ...(searchDigits.length >= 4
                ? [{ phone: { contains: searchDigits } }]
                : []),
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.trialLead.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.trialLead.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getStats() {
    const grouped = await this.prisma.trialLead.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(
      Object.values(TrialLeadStatus).map((status) => [status, 0]),
    ) as Record<TrialLeadStatus, number>;
    for (const row of grouped) byStatus[row.status] = row._count._all;
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
    };
  }

  async updateStatus(id: string, status: TrialLeadStatus, note?: string) {
    const exists = await this.prisma.trialLead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException("So'rov topilmadi");

    return this.prisma.trialLead.update({
      where: { id },
      data: {
        status,
        ...(note !== undefined ? { note: note.trim() || null } : {}),
      },
    });
  }
}
