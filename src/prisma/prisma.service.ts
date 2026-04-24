import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService — connection pool optimizatsiya qilingan.
 *
 * DATABASE_URL da connection_limit va pool_timeout mavjud bo'lsa,
 * Prisma ularni avtomatik qo'llaydi. Aks holda bu yerda log_level
 * production uchun faqat warn/error ko'rsatadi.
 *
 * Connection pool hisoblash:
 *   instances × connection_limit ≤ PostgreSQL max_connections (default 100)
 *   Misol: 8 instance × 10 conn = 80 ≤ 100 ✓
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'production'
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('PostgreSQL ulanish muvaffaqiyatli');
    } catch (err) {
      this.logger.error('PostgreSQL ulanish xatosi', err);
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('PostgreSQL ulanish yopildi');
  }
}
