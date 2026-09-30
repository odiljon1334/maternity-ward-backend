import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

/**
 * Login javobi login mavjudligini oshkor qilmasligi va mobil refresh
 * sessiyani cheksiz uzaytirmasligi (mutlaq muddat) tekshiriladi.
 */
describe('AuthService — login javoblari va mobil sessiya muddati', () => {
  const DAY = 86_400;
  let users: any[];
  let sign: jest.Mock;
  let config: Record<string, string | undefined>;
  let service: AuthService;

  beforeEach(() => {
    users = [];
    sign = jest.fn(() => 'signed-jwt');
    config = {};
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id
            ? (users.find((u) => u.id === where.id) ?? null)
            : (users.find((u) => u.username === where.username) ?? null),
        ),
        update: jest.fn(async () => ({})),
      },
    };
    service = new AuthService(
      prisma,
      { sign } as any,
      { log: jest.fn() } as any,
      {} as any,
      {} as any,
      { get: (key: string) => config[key] } as any,
    );
  });

  const addUser = async (patch: Record<string, unknown> = {}) => {
    const user = {
      id: 'u1',
      username: 'hamshira',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      hospitalId: 'h1',
      passwordHash: await bcrypt.hash('togri-parol', 4),
      ...patch,
    };
    users.push(user);
    return user;
  };

  const loginError = async (username: string, password: string) => {
    try {
      await service.login({ username, password } as any);
    } catch (e) {
      return e as UnauthorizedException;
    }
    throw new Error('login xato bermadi');
  };

  it("mavjud bo'lmagan login va noto'g'ri parol — bir xil javob", async () => {
    await addUser();
    const unknown = await loginError('yoq-odam', 'xato');
    const wrong = await loginError('hamshira', 'xato');

    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect(unknown.message).toBe(wrong.message);
  });

  it("bloklangan hisob — faqat to'g'ri parol bilan aytiladi", async () => {
    await addUser({ status: 'SUSPENDED' });

    const wrong = await loginError('hamshira', 'xato');
    expect(wrong.message).not.toContain('bloklangan');

    const right = await loginError('hamshira', 'togri-parol');
    expect(right.message).toBe('Hisob bloklangan');
  });

  it('login tokeniga sessiya boshlangan vaqt (authAt) yoziladi', async () => {
    await addUser();
    const before = Math.floor(Date.now() / 1000);
    await service.login({
      username: 'hamshira',
      password: 'togri-parol',
    } as any);

    const payload = sign.mock.calls[0][0];
    expect(payload.authAt).toBeGreaterThanOrEqual(before);
  });

  it('refresh authAt ni saqlaydi (sessiya uzaymaydi)', async () => {
    await addUser();
    const authAt = Math.floor(Date.now() / 1000) - 10 * DAY;

    await expect(service.refreshMobileToken('u1', authAt)).resolves.toEqual({
      accessToken: 'signed-jwt',
    });
    expect(sign.mock.calls[0][0].authAt).toBe(authAt);
  });

  it('90 kundan eski sessiya refresh qilinmaydi — qayta login kerak', async () => {
    await addUser();
    const authAt = Math.floor(Date.now() / 1000) - 91 * DAY;

    await expect(
      service.refreshMobileToken('u1', authAt),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sign).not.toHaveBeenCalled();
  });

  it('muddat MOBILE_SESSION_MAX_DAYS bilan sozlanadi', async () => {
    await addUser();
    config.MOBILE_SESSION_MAX_DAYS = '7';
    const authAt = Math.floor(Date.now() / 1000) - 8 * DAY;

    await expect(
      service.refreshMobileToken('u1', authAt),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('parol almashtirilganda sessiya yangidan boshlanadi', async () => {
    await addUser();
    const before = Math.floor(Date.now() / 1000);

    await service.changePasswordMobile('u1', {
      currentPassword: 'togri-parol',
      newPassword: 'yangi-parol-123',
    } as any);

    expect(sign.mock.calls[0][0].authAt).toBeGreaterThanOrEqual(before);
  });
});
