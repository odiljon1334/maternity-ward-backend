import { TelegramAccessService, hashLinkToken, LINK_TOKEN_TTL_MS } from './telegram-access.service';

function makePrisma(row: any) {
  const prisma: any = {
    telegramLinkToken: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async (a: any) => a.data),
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: row && !row.usedAt ? 1 : 0 })),
    },
    employee: {
      update: jest.fn(async (a: any) => a),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  return prisma;
}

const tokenRow = (over: any = {}) => ({
  id: 't1',
  employeeId: 'e1',
  expiresAt: new Date(Date.now() + 60_000),
  usedAt: null,
  employee: { id: 'e1', fullName: 'Karimova Dilnoza', firedAt: null, hospital: { name: 'H1' } },
  ...over,
});

describe('TelegramAccessService — shaxsiy ulanish', () => {
  it('token bazada faqat sha256 ko‘rinishida saqlanadi, 15 daqiqa amal qiladi', async () => {
    const prisma = makePrisma(null);
    const svc = new TelegramAccessService(prisma);
    const { token, expiresAt } = await svc.createLinkToken('e1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const saved = prisma.telegramLinkToken.create.mock.calls[0][0].data;
    expect(saved.tokenHash).toBe(hashLinkToken(token));
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(LINK_TOKEN_TTL_MS);
    // Eski ishlatilmagan havolalar bekor qilinadi
    expect(prisma.telegramLinkToken.deleteMany).toHaveBeenCalledWith({ where: { employeeId: 'e1', usedAt: null } });
  });

  it('yaroqli token → chat xodimga bog‘lanadi, eslatmalar yoqiladi', async () => {
    const prisma = makePrisma(tokenRow());
    const svc = new TelegramAccessService(prisma);
    const res = await svc.consumeLinkToken('A'.repeat(24), '555');
    expect(res).toEqual({ employeeId: 'e1', fullName: 'Karimova Dilnoza', hospitalName: 'H1' });
    expect(prisma.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e1' },
        data: expect.objectContaining({ telegramChatId: '555', telegramReminders: true }),
      }),
    );
  });

  it('muddati o‘tgan / ishlatilgan / ishdan bo‘shagan / noto‘g‘ri format — bog‘lanmaydi', async () => {
    const cases: [any, string][] = [
      [tokenRow({ expiresAt: new Date(Date.now() - 1) }), 'expired'],
      [tokenRow({ usedAt: new Date() }), 'invalid'],
      [tokenRow({ employee: { id: 'e1', fullName: 'X', firedAt: new Date(), hospital: null } }), 'invalid'],
      [null, 'invalid'],
    ];
    for (const [row, expected] of cases) {
      const prisma = makePrisma(row);
      const svc = new TelegramAccessService(prisma);
      expect(await svc.consumeLinkToken('A'.repeat(24), '555')).toBe(expected);
      expect(prisma.employee.update).not.toHaveBeenCalled();
    }
    const prisma = makePrisma(tokenRow());
    expect(await new TelegramAccessService(prisma).consumeLinkToken('bad token!', '1')).toBe('invalid');
    expect(prisma.telegramLinkToken.findUnique).not.toHaveBeenCalled();
  });

  it('parallel ikkinchi /start — token allaqachon band qilingan bo‘lsa bog‘lanmaydi', async () => {
    const prisma = makePrisma(tokenRow());
    prisma.telegramLinkToken.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await new TelegramAccessService(prisma).consumeLinkToken('A'.repeat(24), '555');
    expect(res).toBe('invalid');
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });
});
