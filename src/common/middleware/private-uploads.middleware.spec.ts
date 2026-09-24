import { privateSelfiesMiddleware } from './private-uploads.middleware';

describe('privateSelfiesMiddleware — selfilar faqat vakolatli foydalanuvchiga', () => {
  const jwt: any = {
    verifyAsync: jest.fn(async (t: string) => {
      if (!t.startsWith('ok-')) throw new Error('bad');
      return { sub: t.slice(3), iat: 10_000_000_000 };
    }),
  };
  const users: Record<string, any> = {
    dirA: { id: 'dirA', role: 'DIRECTOR', status: 'ACTIVE', hospitalId: 'hA' },
    dirB: { id: 'dirB', role: 'DIRECTOR', status: 'ACTIVE', hospitalId: 'hB' },
    emp: { id: 'emp', role: 'EMPLOYEE', status: 'ACTIVE', hospitalId: 'hA' },
    other: {
      id: 'other',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      hospitalId: 'hA',
    },
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => users[where.id] ?? null),
    },
    attendanceRecord: {
      findFirst: jest.fn(async () => ({
        employee: { hospitalId: 'hA', userId: 'emp' },
      })),
    },
    hospitalAssistant: { findFirst: jest.fn(async () => null) },
  };
  const mw = privateSelfiesMiddleware(jwt, prisma);

  async function call(cookie?: string) {
    const res: any = {
      headers: {} as Record<string, string>,
      code: 200,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      status(c: number) {
        this.code = c;
        return this;
      },
      json: jest.fn(),
    };
    const next = jest.fn();
    await mw({ path: '/a.jpg', headers: { cookie } } as any, res, next);
    return { res, next };
  }

  it('sessiyasiz — 401, keshlanmaydi', async () => {
    const { res, next } = await call();
    expect(res.code).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it("o'z muassasasi direktori va xodimning o'zi ko'radi", async () => {
    expect((await call('access_token=ok-dirA')).next).toHaveBeenCalled();
    expect((await call('access_token=ok-emp')).next).toHaveBeenCalled();
  });

  it('boshqa muassasa direktori va boshqa xodim — 404', async () => {
    expect((await call('access_token=ok-dirB')).res.code).toBe(404);
    expect((await call('access_token=ok-other')).res.code).toBe(404);
  });
});
