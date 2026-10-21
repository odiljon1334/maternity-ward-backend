import { BadRequestException } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';

describe('AuditLogService filters', () => {
  const setup = () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockReturnValue('records'),
        count: jest.fn().mockReturnValue('count'),
      },
      $transaction: jest.fn().mockResolvedValue([[], 0]),
    };
    return { prisma, service: new AuditLogService(prisma as any) };
  };

  it('tenant scope search va sana filtrlari bilan birga saqlanadi', async () => {
    const { prisma, service } = setup();
    await service.findAll({
      hospitalId: 'own',
      search: 'testuser',
      ip: '203.0.113.4',
      from: '2026-10-21T00:00:00+05:00',
      to: '2026-10-21T23:59:59.999+05:00',
      page: 2,
      limit: 20,
    });
    const query = prisma.auditLog.findMany.mock.calls[0][0];
    expect(query.where).toEqual(
      expect.objectContaining({
        hospitalId: 'own',
        ip: '203.0.113.4',
        createdAt: {
          gte: new Date('2026-10-20T19:00:00Z'),
          lte: new Date('2026-10-21T18:59:59.999Z'),
        },
      }),
    );
    expect(query.where.OR).toContainEqual({
      details: { path: ['username'], string_contains: 'testuser' },
    });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: query.where });
    expect(query.skip).toBe(20);
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it.each([
    { page: 0 },
    { page: NaN },
    { page: 1.5 },
    { limit: 101 },
    { limit: -1 },
    { ip: 'not-an-ip' },
    { from: 'yesterday' },
    { from: '2026-10-22T00:00:00Z', to: '2026-10-21T00:00:00Z' },
  ])('invalid query rad etiladi: %j', async (params) => {
    const { prisma, service } = setup();
    await expect(service.findAll(params)).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('bo‘sh natija total bilan qaytadi', async () => {
    const { service } = setup();
    await expect(service.findAll({})).resolves.toEqual({
      records: [],
      total: 0,
      page: 1,
      limit: 50,
      pages: 0,
    });
  });

  it('noto‘g‘ri retention o‘chirishgacha rad etiladi', async () => {
    const { service } = setup();
    await expect(service.clearOldLogs(NaN, 'admin')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.clearOldLogs(0, 'admin')).rejects.toThrow(
      BadRequestException,
    );
  });
});
