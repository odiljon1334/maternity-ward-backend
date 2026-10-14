import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import {
  HospitalBlockedTelegramError,
  TelegramService,
} from '../telegram/telegram.service';
import { HOSPITAL_BLOCKED_LOGIN_MESSAGE } from './utils/hospital-access.util';
import {
  isHospitalBillingBlocked,
  isHospitalBlocked,
} from './utils/payment.util';
import { verifySocketUser } from './utils/ws-auth.util';

/**
 * Admin muassasani bloklaganda: hech kim (direktor va adminlar ham) kira
 * olmaydi, mavjud sessiyalar tugaydi, Telegram jim turadi, terminal
 * davomati esa yozilaveradi. SUPER_ADMIN ta'sirlanmaydi.
 */
describe('Muassasa bloki (admin)', () => {
  describe('login', () => {
    let users: any[];
    let audit: jest.Mock;
    let service: AuthService;

    beforeEach(async () => {
      audit = jest.fn();
      const passwordHash = await bcrypt.hash('togri-parol', 4);
      users = [
        {
          id: 'dir',
          username: 'direktor',
          role: 'DIRECTOR',
          status: 'ACTIVE',
          hospitalId: 'h1',
          passwordHash,
          hospital: { id: 'h1', isBlocked: true },
        },
        {
          id: 'super',
          username: 'superadmin',
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          hospitalId: null,
          passwordHash,
          hospital: null,
        },
      ];
      const prisma: any = {
        user: {
          findUnique: jest.fn(
            async ({ where }: any) =>
              users.find((u) => u.username === where.username) ?? null,
          ),
          update: jest.fn(async () => ({})),
        },
      };
      service = new AuthService(
        prisma,
        { sign: () => 'jwt' } as any,
        { log: audit } as any,
        {} as any,
        {} as any,
        { get: () => undefined } as any,
      );
    });

    it("bloklangan muassasa direktori to'g'ri parol bilan ham kira olmaydi", async () => {
      await expect(
        service.login({ username: 'direktor', password: 'togri-parol' }),
      ).rejects.toThrow(HOSPITAL_BLOCKED_LOGIN_MESSAGE);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN_FAILED',
          details: expect.objectContaining({ reason: 'hospital_blocked' }),
        }),
      );
    });

    it("noto'g'ri parolda blok haqida aytilmaydi", async () => {
      const error = await service
        .login({ username: 'direktor', password: 'xato' })
        .catch((e) => e);
      expect(error.message).not.toContain('bloklangan');
    });

    it('SUPER_ADMIN kiraveradi', async () => {
      await expect(
        service.login({ username: 'superadmin', password: 'togri-parol' }),
      ).resolves.toMatchObject({ accessToken: 'jwt' });
    });
  });

  describe('mavjud sessiya (JWT)', () => {
    const strategyFor = (user: any, assistantCounts?: [number, number]) => {
      const prisma: any = {
        user: { findUnique: jest.fn(async () => user) },
        hospitalAssistant: {
          count: jest
            .fn()
            .mockResolvedValueOnce(assistantCounts?.[0] ?? 0)
            .mockResolvedValueOnce(assistantCounts?.[1] ?? 0),
        },
      };
      return new JwtStrategy({ get: () => 'secret' } as any, prisma);
    };
    const base = {
      id: 'u1',
      status: 'ACTIVE',
      username: 'u',
      hospitalId: 'h1',
      permissionOverrides: [],
    };
    const payload = { sub: 'u1', role: 'X', username: 'u' };

    it.each(['ADMIN', 'DIRECTOR', 'DEPARTMENT_HEAD', 'EMPLOYEE'])(
      '%s — muassasa bloklangach keyingi so‘rov 401',
      async (role) => {
        const strategy = strategyFor({
          ...base,
          role,
          hospital: { isBlocked: true },
        });
        await expect(strategy.validate(payload)).rejects.toThrow(
          new UnauthorizedException(HOSPITAL_BLOCKED_LOGIN_MESSAGE),
        );
      },
    );

    it('blok ochilgach sessiya yana ishlaydi', async () => {
      const strategy = strategyFor({
        ...base,
        role: 'DIRECTOR',
        hospital: { isBlocked: false },
      });
      await expect(strategy.validate(payload)).resolves.toMatchObject({
        sub: 'u1',
      });
    });

    it('yordamchi admin: biriktirilgan hammasi bloklangan bo‘lsa kira olmaydi', async () => {
      const strategy = strategyFor(
        { ...base, role: 'ASSISTANT_ADMIN', hospitalId: null, hospital: null },
        [2, 0],
      );
      await expect(strategy.validate(payload)).rejects.toThrow(
        HOSPITAL_BLOCKED_LOGIN_MESSAGE,
      );
    });

    it('yordamchi admin: bitta muassasasi ochiq bo‘lsa kiradi', async () => {
      const strategy = strategyFor(
        { ...base, role: 'ASSISTANT_ADMIN', hospitalId: null, hospital: null },
        [2, 1],
      );
      await expect(strategy.validate(payload)).resolves.toMatchObject({
        sub: 'u1',
      });
    });

    it('SUPER_ADMIN muassasa blokidan ta’sirlanmaydi', async () => {
      const strategy = strategyFor({
        ...base,
        role: 'SUPER_ADMIN',
        hospital: { isBlocked: true },
      });
      await expect(strategy.validate(payload)).resolves.toMatchObject({
        sub: 'u1',
      });
    });

    it('WebSocket (jonli xarita) ulanishi ham rad etiladi', async () => {
      const prisma: any = {
        user: {
          findUnique: jest.fn(async () => ({
            ...base,
            role: 'DIRECTOR',
            hospital: { isBlocked: true },
          })),
        },
      };
      const jwt: any = { verifyAsync: jest.fn(async () => ({ sub: 'u1' })) };
      await expect(verifySocketUser(jwt, prisma, 'token')).resolves.toBeNull();
    });
  });

  describe('Telegram', () => {
    function setup(links: {
      subs: Array<{ hospital: { isBlocked: boolean } }>;
      employees: Array<{ hospital: { isBlocked: boolean } }>;
    }) {
      const prisma: any = {
        telegramSubscription: { findMany: jest.fn(async () => links.subs) },
        employee: { findMany: jest.fn(async () => links.employees) },
      };
      const service = new TelegramService(
        {} as any,
        prisma,
        {} as any,
        {} as any,
      );
      const realCallApi = jest.fn(async () => ({ message_id: 1 }));
      const telegram: any = { callApi: realCallApi };
      (service as any).bot = { telegram };
      (service as any).silenceBlockedHospitalChats();
      return { telegram, realCallApi };
    }

    it('faqat bloklangan muassasaga bog‘langan chatga xabar ketmaydi', async () => {
      const { telegram, realCallApi } = setup({
        subs: [{ hospital: { isBlocked: true } }],
        employees: [{ hospital: { isBlocked: true } }],
      });
      await expect(
        telegram.callApi('sendMessage', { chat_id: 42, text: 'x' }),
      ).rejects.toBeInstanceOf(HospitalBlockedTelegramError);
      await expect(
        telegram.callApi('sendPhoto', { chat_id: 42 }),
      ).rejects.toBeInstanceOf(HospitalBlockedTelegramError);
      expect(realCallApi).not.toHaveBeenCalled();
    });

    it('xato 403 emas — obuna va eslatmalar o‘chirib yuborilmaydi', async () => {
      const { telegram } = setup({
        subs: [{ hospital: { isBlocked: true } }],
        employees: [],
      });
      const error = await telegram
        .callApi('sendMessage', { chat_id: 42 })
        .catch((e: any) => e);
      expect(error?.response?.error_code ?? error?.code).not.toBe(403);
    });

    it('ochiq muassasa va bog‘lanmagan chat odatdagidek ishlaydi', async () => {
      const open = setup({
        subs: [{ hospital: { isBlocked: false } }],
        employees: [],
      });
      await open.telegram.callApi('sendMessage', { chat_id: 1 });
      expect(open.realCallApi).toHaveBeenCalledTimes(1);

      const unlinked = setup({ subs: [], employees: [] });
      await unlinked.telegram.callApi('sendMessage', { chat_id: 2 });
      expect(unlinked.realCallApi).toHaveBeenCalledTimes(1);
    });

    it('xabar yubormaydigan metodlar tekshirilmaydi', async () => {
      const { telegram, realCallApi } = setup({
        subs: [{ hospital: { isBlocked: true } }],
        employees: [],
      });
      await telegram.callApi('getMe', {});
      expect(realCallApi).toHaveBeenCalledWith('getMe', {}, undefined);
    });
  });

  describe('terminal davomati', () => {
    const prisma: any = {
      hospital: {
        findUnique: jest.fn(async () => ({
          isBlocked: true,
          createdAt: new Date('2026-01-01'),
        })),
      },
    };

    it('admin bloki davomat yozishni to‘xtatmaydi, to‘lov bloki to‘xtatadi', async () => {
      const previous = process.env.BILLING_AUTO_BLOCK;
      delete process.env.BILLING_AUTO_BLOCK;
      try {
        await expect(isHospitalBlocked(prisma, 'h1')).resolves.toBe(true);
        await expect(isHospitalBillingBlocked(prisma, 'h1')).resolves.toBe(
          false,
        );
      } finally {
        if (previous !== undefined) process.env.BILLING_AUTO_BLOCK = previous;
      }
    });
  });
});
