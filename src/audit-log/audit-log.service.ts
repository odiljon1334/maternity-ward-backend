import { Injectable } from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

  /** Asinxron log — xato bo'lsa asosiy operatsiyani to'xtatmaydi */
  log(data: AuditLogData): void {
    this.prisma.auditLog.create({ data }).catch(() => {
      /* silent */
    });
  }

  async findAll(params: {
    hospitalId?: string;
    entity?: string;
    action?: string;
    page?: number;
    limit?: number;
  }) {
    const { hospitalId, entity, action, page = 1, limit = 50 } = params;
    const where: Record<string, unknown> = {};
    if (hospitalId) where.hospitalId = hospitalId;
    if (entity) where.entity = entity;
    if (action) where.action = action;

    const [records, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    // "data" deb nomlamaslik — response interceptor uni unwrap qilib yuboradi
    return { records, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /** N kundan eski loglarni o'chirish — faqat SUPER_ADMIN chaqiradi */
  async clearOldLogs(olderThanDays: number, clearedByUserId: string) {
    const days = Math.max(7, olderThanDays); // kamida 7 kun
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
