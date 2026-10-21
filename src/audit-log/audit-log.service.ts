import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isIP } from 'node:net';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditLogData {
  userId?: string;
  hospitalId?: string;
  action: string; // CREATE | UPDATE | DELETE | FIRE | IMPORT_CSV | GENERATE | APPROVE | EXPORT | LOGIN
  entity: string; // Employee | PayrollRecord | Schedule | Department | Position | User
  entityId?: string;
  details?: object;
  ip?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Asinxron log — xato bo'lsa asosiy operatsiyani to'xtatmaydi */
  log(data: AuditLogData): void {
    this.prisma.auditLog.create({ data }).catch(() => {
      this.logger.error('Audit yozuvini saqlash amalga oshmadi');
    });
  }

  async findAll(params: {
    hospitalId?: string;
    entity?: string;
    action?: string;
    page?: number;
    limit?: number;
    search?: string;
    ip?: string;
    from?: string;
    to?: string;
  }) {
    const { hospitalId, entity, action, page = 1, limit = 50 } = params;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new BadRequestException(
        'Sahifa 1–100000, limit 1–100 oralig‘ida bo‘lishi kerak',
      );
    }
    const search = params.search?.trim();
    const ip = params.ip?.trim();
    if ((search?.length ?? 0) > 100 || (ip && !isIP(ip))) {
      throw new BadRequestException(
        'Qidiruv 100 belgidan oshmasin; IP manzilni tekshiring',
      );
    }
    const parseDate = (value?: string) => {
      if (!value) return undefined;
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) ||
        !Number.isFinite(Date.parse(value))
      ) {
        throw new BadRequestException(
          'Vaqt ISO formatida va vaqt zonasi bilan yuborilishi kerak',
        );
      }
      return new Date(value);
    };
    const from = parseDate(params.from);
    const to = parseDate(params.to);
    if (from && to && from > to)
      throw new BadRequestException('Sana oralig‘i noto‘g‘ri');
    const where: Prisma.AuditLogWhereInput = {};
    if (ip) where.ip = ip;
    if (from || to) where.createdAt = { gte: from, lte: to };
    if (search)
      where.OR = [
        { id: { contains: search, mode: 'insensitive' } },
        { userId: { contains: search, mode: 'insensitive' } },
        { entityId: { contains: search, mode: 'insensitive' } },
        { ip: { contains: search, mode: 'insensitive' } },
        { details: { path: ['username'], string_contains: search } },
      ];
    if (hospitalId) where.hospitalId = hospitalId;
    if (entity) where.entity = entity;
    if (action) where.action = action;

    const [records, total] = await this.prisma.$transaction(
      [
        this.prisma.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.auditLog.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    // "data" deb nomlamaslik — response interceptor uni unwrap qilib yuboradi
    return { records, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /** N kundan eski loglarni o'chirish — faqat SUPER_ADMIN chaqiradi */
  async clearOldLogs(olderThanDays: number, clearedByUserId: string) {
    if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 7) {
      throw new BadRequestException('Kamida 7 kunlik butun son kiriting');
    }
    const days = olderThanDays; // kamida 7 kun
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { count } = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    // O'chirish amalini o'zi ham log qilamiz
    this.log({
      userId: clearedByUserId,
      action: 'CLEAR_LOGS',
      entity: 'AuditLog',
      details: { deletedCount: count, olderThanDays: days },
    });

    return { deleted: count, olderThanDays: days };
  }
}
