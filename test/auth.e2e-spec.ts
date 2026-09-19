import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AuthModule } from '../src/auth/auth.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { AuditLogModule } from '../src/audit-log/audit-log.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

/**
 * Auth oqimining HTTP darajasidagi (e2e) testlari — Faza 3.4.
 *
 * HAQIQIY bazasiz ishlaydi (auth.service.spec.ts'dagi kabi PrismaService
 * xotiradagi soxta ma'lumotlar bilan almashtiriladi), lekin haqiqiy HTTP
 * so'rovlar orqali (supertest) — ya'ni DTO validatsiyasi, JwtAuthGuard,
 * RolesGuard, ThrottlerGuard, ValidationPipe, AllExceptionsFilter va
 * ResponseInterceptor kabi butun so'rov zanjiri ham tekshiriladi (bularning
 * hech biri servis-darajasidagi testlarda tekshirilmaydi).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-e2e-only';

function makeFakePrisma() {
  const users: any[] = [];

  return {
    __state: { users },
    // AuditLogService bu orqali "fire-and-forget" log yozadi — haqiqiy
    // yozuv shart emas, faqat funksiya sifatida mavjud bo'lishi kifoya.
    auditLog: {
      create: jest.fn(async () => ({})),
    },
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
  };
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof makeFakePrisma>;
  const PLAIN_PASSWORD = 'Sup3rSecret!';

  beforeAll(async () => {
    prisma = makeFakePrisma();
    const passwordHash = await bcrypt.hash(PLAIN_PASSWORD, 10);
    prisma.__state.users.push({
      id: 'user-1',
      username: 'admin_test',
      passwordHash,
      status: 'ACTIVE',
      role: 'SUPER_ADMIN',
      lang: 'uz',
      hospitalId: null,
      email: null,
      emailVerifiedAt: null,
    });
    // Bloklangan hisob — "hisob bloklangan" holatini tekshirish uchun
    prisma.__state.users.push({
      id: 'user-2',
      username: 'blocked_test',
      passwordHash,
      status: 'BLOCKED',
      role: 'ADMIN',
      lang: 'uz',
      hospitalId: null,
      email: null,
      emailVerifiedAt: null,
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        // @Global() modul — shu yerda import qilinishi kifoya, keyin butun
        // grafda (TelegramModule, AuditLogModule va h.k.) ham mavjud bo'ladi.
        PrismaModule,
        AuditLogModule,
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      // Auth controller'dagi login endpoint 15 daqiqada 10 urinish bilan
      // cheklangan (@Throttle) — bu fayl throttling'ning o'zini emas, auth
      // oqimini tekshiradi va bir nechta test bir xil "IP"dan (127.0.0.1)
      // ko'p marta /auth/login'ga so'rov yuboradi, shuning uchun bu yerda
      // real throttling o'chirilgan (throttling alohida test bilan
      // tekshiriladi, agar kerak bo'lsa).
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/login', () => {
    it("to'g'ri login/parol bilan JWT token va foydalanuvchi ma'lumotini qaytaradi", async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: PLAIN_PASSWORD })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(res.body.data.accessToken.length).toBeGreaterThan(10);
      expect(res.body.data.user).toMatchObject({
        id: 'user-1',
        username: 'admin_test',
        role: 'SUPER_ADMIN',
      });
    });

    it("noto'g'ri parolda 401 qaytaradi va token bermaydi", async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: 'wrong_password' })
        .expect(401);

      expect(res.body.data).toBeUndefined();
    });

    it("mavjud bo'lmagan foydalanuvchida 401 qaytaradi", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'no_such_user', password: PLAIN_PASSWORD })
        .expect(401);
    });

    it('bloklangan hisobda 401 qaytaradi (parol to‘g‘ri bo‘lsa ham)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'blocked_test', password: PLAIN_PASSWORD })
        .expect(401);
    });

    it('DTO validatsiyasi: juda qisqa parolda 400 qaytaradi (servisga yetib bormaydi)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: '123' })
        .expect(400);
    });

    it('username yo‘q bo‘lsa 400 qaytaradi', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ password: PLAIN_PASSWORD })
        .expect(400);
    });
  });

  describe('GET /api/v1/auth/profile', () => {
    it('Authorization header bo‘lmasa 401 qaytaradi', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/profile')
        .expect(401);
    });

    it('yaroqsiz JWT token bilan 401 qaytaradi', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/profile')
        .set('Authorization', 'Bearer yaroqsiz.token.bu-yerda')
        .expect(401);
    });

    it('haqiqiy JWT token bilan profil ma’lumotini qaytaradi', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: PLAIN_PASSWORD });
      const token = loginRes.body.data.accessToken;

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data.username).toBe('admin_test');
      expect(res.body.data.role).toBe('SUPER_ADMIN');
    });
  });

  describe('PUT /api/v1/auth/change-password', () => {
    it('tokensiz 401 qaytaradi', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/auth/change-password')
        .send({ currentPassword: PLAIN_PASSWORD, newPassword: 'YangiParol1!' })
        .expect(401);
    });

    it("joriy parol noto'g'ri bo'lsa 400 qaytaradi", async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: PLAIN_PASSWORD });
      const token = loginRes.body.data.accessToken;

      await request(app.getHttpServer())
        .put('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'notogri', newPassword: 'YangiParol1!' })
        .expect(400);
    });

    it("to'g'ri joriy parol bilan parolni almashtiradi va yangi parol bilan qayta login qilish mumkin bo'ladi", async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: PLAIN_PASSWORD });
      const token = loginRes.body.data.accessToken;

      await request(app.getHttpServer())
        .put('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PLAIN_PASSWORD, newPassword: 'YangiParol1!' })
        .expect(200);

      // Eski parol endi ishlamasligi kerak
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: PLAIN_PASSWORD })
        .expect(401);

      // Yangi parol bilan muvaffaqiyatli login
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin_test', password: 'YangiParol1!' })
        .expect(201);
    });
  });
});
