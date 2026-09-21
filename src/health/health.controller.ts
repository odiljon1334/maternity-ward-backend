import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response) {
    let dbStatus = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    const status = dbStatus === 'ok' ? 'ok' : 'degraded';

    // External uptime monitors must receive a failing HTTP status when the
    // API cannot reach its mandatory database dependency. Returning 200 with
    // "degraded" made production outages invisible to HTTP-only monitors.
    if (status === 'degraded') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      services: {
        database: dbStatus,
      },
    };
  }
}
