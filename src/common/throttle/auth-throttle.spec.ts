import { CanActivate, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController } from '../../auth/auth.controller';
import { AuthService } from '../../auth/auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PublicController } from '../../public/public.controller';
import { SupportBotService } from '../../support-bot/support-bot.service';
import { TrialLeadsService } from '../../trial-leads/trial-leads.service';
import { LOGIN_ATTEMPTS_PER_IP, THROTTLERS } from './auth-throttle';

/**
 * Login cheklovi IP + login bo'yicha: bir Wi-Fi'dagi (bitta IP) xodimlar
 * bir-biriga xalaqit bermaydi, bitta hisobga parol taxmin qilish esa
 * 10 urinishdan keyin to'xtaydi. Marketing formasi limiti login'ga
 * tegmaydi.
 */
describe('Login cheklovi (IP + login)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const fakeUserGuard: CanActivate = {
      canActivate: (ctx) => {
        const req = ctx.switchToHttp().getRequest();
        req.user = { sub: req.headers['x-test-user'] };
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(THROTTLERS)],
      controllers: [AuthController, PublicController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            login: jest.fn(async () => ({
              accessToken: 't',
              user: { id: 'u', role: 'EMPLOYEE' },
            })),
            refreshMobileToken: jest.fn(async () => ({ accessToken: 't' })),
          },
        },
        { provide: SupportBotService, useValue: {} },
        {
          provide: TrialLeadsService,
          useValue: { create: jest.fn(async () => ({})) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeUserGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const login = (username: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ username, password: 'xato-parol' });

  it('bitta loginga 10 urinishdan keyin 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await login('hamshira1')).status).toBe(201);
    }
    expect((await login('hamshira1')).status).toBe(429);
    // Login katta-kichik harf yoki bo'shliq bilan aylanib o'tilmaydi
    expect((await login('  HAMSHIRA1 ')).status).toBe(429);
  });

  it('bir Wi-Fi’dagi boshqa xodimlar bloklanmaydi', async () => {
    for (let i = 0; i < 10; i += 1) await login('hamshira1');
    expect((await login('hamshira1')).status).toBe(429);
    for (let i = 0; i < 30; i += 1) {
      expect((await login(`xodim${i}`)).status).toBe(201);
    }
  });

  it('marketing formasi limiti (5/soat) login’ga tegmaydi', async () => {
    for (let i = 0; i < 8; i += 1) {
      expect((await login(`xodim${i}`)).status).toBe(201);
    }
  });

  it(`bitta IP dan jami ${LOGIN_ATTEMPTS_PER_IP} urinishdan keyin 429`, async () => {
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_IP; i += 1) {
      expect((await login(`xodim${i}`)).status).toBe(201);
    }
    expect((await login('yangi-xodim')).status).toBe(429);
  });

  it('mobil token yangilash foydalanuvchi bo‘yicha hisoblanadi', async () => {
    const refresh = (user: string) =>
      request(app.getHttpServer())
        .post('/auth/mobile/refresh')
        .set('x-test-user', user);
    for (let i = 0; i < 30; i += 1) {
      expect((await refresh('u1')).status).toBe(201);
    }
    expect((await refresh('u1')).status).toBe(429);
    expect((await refresh('u2')).status).toBe(201);
  });
});
