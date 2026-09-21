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

@Injectable()
export class TrialLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  capture(input: CaptureTrialLeadInput) {
    return this.prisma.trialLead.create({ data: input });
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
