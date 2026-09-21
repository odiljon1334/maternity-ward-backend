import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const response = {
    status: jest.fn(),
  } as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok without changing the HTTP status when the database is ready', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma);

    const result = await controller.check(response);

    expect(result.status).toBe('ok');
    expect(result.services.database).toBe('ok');
    expect(response.status).not.toHaveBeenCalled();
  });

  it('returns HTTP 503 when the database is unavailable', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma);

    const result = await controller.check(response);

    expect(result.status).toBe('degraded');
    expect(result.services.database).toBe('error');
    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });
});
