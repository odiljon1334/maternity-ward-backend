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

@Injectable()
export class TrialLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  capture(input: CaptureTrialLeadInput) {
    return this.prisma.trialLead.create({ data: input });
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
    const where: Prisma.TrialLeadWhereInput = {
      ...(query.source ? { source: query.source } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { institutionName: { contains: search, mode: 'insensitive' } },
              { contactName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
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
