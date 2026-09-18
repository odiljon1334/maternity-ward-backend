import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { TelegramService } from '../telegram/telegram.service';

/**
 * Ushbu test HAQIQIY bazasiz ishlaydi — PrismaService xotiradagi (in-memory)
 * soxta ma'lumotlar bilan almashtiriladi. Maqsad: 1.1-band (email tasdiqlash +
 * parolni tiklash) mantig'ini bazaga ulanmasdan to'liq tekshirish.
 */

function makeFakePrisma() {
  let idCounter = 1;
  const nextId = () => `id-${idCounter++}`;

  const users: any[] = [];
  const emailOtpTokens: any[] = [];
  const passwordResetTokens: any[] = [];

  return {
    __state: { users, emailOtpTokens, passwordResetTokens },

    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return users.find((u) => u.id === where.id) ?? null;
        if (where.username)
          return users.find((u) => u.username === where.username) ?? null;
        if (where.email)
          return users.find((u) => u.email === where.email) ?? null;
        return null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      }),
    },

    emailOtpToken: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        emailOtpTokens
          .filter(
            (t) =>
              t.userId === where.userId &&
              t.purpose === where.purpose &&
              (where.consumedAt === null ? t.consumedAt === null : true),
          )
          .forEach((t) => Object.assign(t, data));
        return { count: 0 };
      }),
      create: jest.fn(async ({ data }: any) => {
        const token = { id: nextId(), attempts: 0, consumedAt: null, createdAt: new Date(), ...data };
        emailOtpTokens.push(token);
        return token;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          emailOtpTokens
            .filter(
              (t) =>
                t.userId === where.userId &&
                t.purpose === where.purpose &&
                t.consumedAt === null &&
                t.expiresAt >= new Date(),
            )
            .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const t = emailOtpTokens.find((x) => x.id === where.id);
        Object.assign(t, data);
        return t;
      }),
    },

    passwordResetToken: {
      create: jest.fn(async ({ data }: any) => {
        const token = { id: nextId(), consumedAt: null, createdAt: new Date(), ...data };
        passwordResetTokens.push(token);
        return token;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return (
          passwordResetTokens.find((t) => t.tokenHash === where.tokenHash) ??
          null
        );
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          passwordResetTokens
            .filter(
              (t) =>
                t.userId === where.userId &&
                where.channel.in.includes(t.channel) &&
                t.consumedAt === null &&
                t.expiresAt >= new Date(),
            )
            .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const t = passwordResetTokens.find((x) => x.id === where.id);
        Object.assign(t, data);
        return t;
      }),
    },

    $transaction: jest.fn(async (ops: Promise<any>[]) => Promise.all(ops)),

    __addUser(u: any) {
      users.push(u);
      return u;
    },
  };
}

describe('AuthService — Email tasdiqlash va parolni tiklash (1.1-band)', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makeFakePrisma>;
  let mailService: { sendOtpEmail: jest.Mock; sendPasswordResetEmail: jest.Mock };
  let telegramService: { sendToChat: jest.Mock };

  beforeEach(async () => {
    prisma = makeFakePrisma();
    mailService = {
      sendOtpEmail: jest.fn(async () => true),
      sendPasswordResetEmail: jest.fn(async () => true),
    };
    telegramService = { sendToChat: jest.fn(async () => undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: () => 'fake-jwt' } },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: MailService, useValue: mailService },
        { provide: TelegramService, useValue: telegramService },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'FRONTEND_URL' ? 'https://clinicuk24.com' : undefined) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('Email qo\'shish → OTP → tasdiqlash → parolni tiklash (email orqali) — TO\'LIQ OQIM', async () => {
    const passwordHash = await bcrypt.hash('EskiParol123', 12);
    const user = prisma.__addUser({
      id: 'user-1',
      username: 'direktor1',
      passwordHash,
      email: null,
      emailVerifiedAt: null,
      employee: { fullName: 'Test Direktor', telegramChatId: null },
    });

    // 1) Email qo'shish — OTP yuborilishi kerak
    await service.updateEmail(user.id, { email: 'direktor1@example.com' } as any);
    expect(user.email).toBe('direktor1@example.com');
    expect(user.emailVerifiedAt).toBeNull();
    expect(mailService.sendOtpEmail).toHaveBeenCalledTimes(1);
    const [, sentCode] = mailService.sendOtpEmail.mock.calls[0];

    // 2) Noto'g'ri kod — rad etilishi kerak
    await expect(
      service.verifyEmailOtp(user.id, { code: '000000' } as any),
    ).rejects.toThrow();

    // 3) To'g'ri kod — tasdiqlanishi kerak
    await service.verifyEmailOtp(user.id, { code: sentCode } as any);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);

    // 4) Parolni tiklash so'rovi — email orqali havola yuborilishi kerak
    const result = await service.forgotPassword({ username: 'direktor1' } as any);
    expect((result as any).channel).toBe('EMAIL');
    expect(mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [, resetUrl] = mailService.sendPasswordResetEmail.mock.calls[0];
    const token = new URL(resetUrl).searchParams.get('token')!;
    expect(token).toBeTruthy();

    // 5) Noto'g'ri token bilan tiklash — rad etilishi kerak
    await expect(
      service.resetPassword({ token: 'yolgon-token', newPassword: 'YangiParol456' } as any),
    ).rejects.toThrow();

    // 6) To'g'ri token bilan yangi parol qo'yish
    await service.resetPassword({ token, newPassword: 'YangiParol456' } as any);
    expect(await bcrypt.compare('YangiParol456', user.passwordHash)).toBe(true);
    expect(await bcrypt.compare('EskiParol123', user.passwordHash)).toBe(false);

    // 7) Bir marta ishlatilgan token qayta ishlatib bo'lmaydi
    await expect(
      service.resetPassword({ token, newPassword: 'YanaBoshqa789' } as any),
    ).rejects.toThrow();
  });

  it('Email yo\'q, lekin Telegram ulangan xodim — Telegram OTP orqali parolni tiklash', async () => {
    const passwordHash = await bcrypt.hash('EskiParol123', 12);
    const user = prisma.__addUser({
      id: 'user-2',
      username: 'hamshira1',
      passwordHash,
      email: null,
      emailVerifiedAt: null,
      employee: { fullName: 'Hamshira Ona', telegramChatId: '123456789' },
    });

    const result = await service.forgotPassword({ username: 'hamshira1' } as any);
    expect((result as any).channel).toBe('TELEGRAM');
    expect(telegramService.sendToChat).toHaveBeenCalledTimes(1);

    const [chatId, message] = telegramService.sendToChat.mock.calls[0];
    expect(chatId).toBe('123456789');
    const code = message.match(/(\d{6})/)[1];

    await service.verifyResetOtp({
      username: 'hamshira1',
      code,
      newPassword: 'YangiParolTG789',
    } as any);

    expect(await bcrypt.compare('YangiParolTG789', user.passwordHash)).toBe(true);
  });

  it('Na email, na Telegram — xavfsiz umumiy xabar qaytadi, xatolik tashlamaydi', async () => {
    prisma.__addUser({
      id: 'user-3',
      username: 'superadmin',
      passwordHash: 'x',
      email: null,
      emailVerifiedAt: null,
      employee: null,
    });

    const result = await service.forgotPassword({ username: 'superadmin' } as any);
    expect((result as any).channel).toBeUndefined();
    expect((result as any).message).toBeTruthy();
  });

  it('Mavjud bo\'lmagan username — xavfsiz umumiy xabar (hisob mavjudligini oshkor qilmaydi)', async () => {
    const result = await service.forgotPassword({ username: 'yoq_user' } as any);
    expect((result as any).message).toBeTruthy();
  });
});
