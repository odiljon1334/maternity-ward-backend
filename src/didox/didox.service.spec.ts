import axios from 'axios';
import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { DidoxService } from './didox.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * DidoxService uchun servis-darajasidagi unit testlar — haqiqiy Didox
 * hisobisiz. axios to'liq soxta (`axios.create()` xuddi shu mock obyektni
 * qaytaradi), Prisma esa soxta-Prisma naqshi (users.service.spec.ts bilan
 * bir xil uslub). Bu testlar FAQAT so'rov/javob qayta ishlash mantig'ini
 * tekshiradi — haqiqiy Didox endpoint javob tuzilishini emas (u hali
 * tasdiqlanmagan, didox.service.ts'dagi izohga qarang).
 */

function makeFakePrisma() {
  const credentials = new Map<string, any>();

  return {
    __state: credentials,
    hospitalDidoxCredential: {
      findUnique: jest.fn(
        async ({ where }: any) => credentials.get(where.hospitalId) ?? null,
      ),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const existing = credentials.get(where.hospitalId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created = {
          id: 'cred-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        credentials.set(where.hospitalId, created);
        return created;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const existing = credentials.get(where.hospitalId);
        credentials.delete(where.hospitalId);
        return existing;
      }),
    },
  };
}

function makeConfig(baseUrl = 'https://devapi.example.uz') {
  return {
    get: jest.fn((key: string, fallback?: string) =>
      key === 'DIDOX_API_BASE_URL' ? baseUrl : fallback,
    ),
  };
}

describe('DidoxService', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makeFakePrisma();
    // axios.create({...}) chaqirilganda xuddi shu mocked axios obyektini
    // qaytarsin — shunda mockedAxios.get/post ustidan nazorat qilamiz.
    (mockedAxios.create as jest.Mock).mockReturnValue(mockedAxios);
  });

  describe('konfiguratsiya', () => {
    it("DIDOX_API_BASE_URL bo'lmasa — har qanday chaqiruv BadGatewayException beradi", async () => {
      const svc = new DidoxService(makeConfig('') as any, prisma as any);
      await expect(svc.getChallenge('hosp-1', 'ABC123')).rejects.toThrow(
        BadGatewayException,
      );
    });
  });

  describe('getChallenge', () => {
    it('authId muvaffaqiyatli olinsa — credential yozuviga lastAuthId sifatida saqlanadi', async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      (mockedAxios.get as jest.Mock).mockResolvedValue({
        data: { authId: 'auth-xyz' },
      });

      const result = await svc.getChallenge('hosp-1', 'ABC123');

      expect(result).toEqual({ authId: 'auth-xyz' });
      expect(mockedAxios.get).toHaveBeenCalledWith('/v1/auth/authId/ABC123');
      const saved = prisma.__state.get('hosp-1');
      expect(saved.lastAuthId).toBe('auth-xyz');
      expect(saved.serialNumber).toBe('ABC123');
    });

    it('Didox authId qaytarmasa — BadGatewayException', async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      (mockedAxios.get as jest.Mock).mockResolvedValue({ data: {} });

      await expect(svc.getChallenge('hosp-1', 'ABC123')).rejects.toThrow(
        BadGatewayException,
      );
    });

    it("tarmoq xatosi bo'lsa — BadGatewayException bilan o'raladi", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      (mockedAxios.get as jest.Mock).mockRejectedValue(
        new Error('ECONNREFUSED'),
      );

      await expect(svc.getChallenge('hosp-1', 'ABC123')).rejects.toThrow(
        BadGatewayException,
      );
    });
  });

  describe('login', () => {
    it('token muvaffaqiyatli olinsa — expiresAt hisoblab, credential yangilanadi', async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      (mockedAxios.post as jest.Mock).mockResolvedValue({
        data: { token: 'tok-123', expiresIn: 3600 },
      });

      const before = Date.now();
      const result = await svc.login('hosp-1', {
        serialNumber: 'ABC123',
        authId: 'auth-xyz',
        pkcs7: 'signed-blob',
      });

      expect(result.token).toBe('tok-123');
      expect(result.expiresAt.getTime()).toBeGreaterThan(before);
      const saved = prisma.__state.get('hosp-1');
      expect(saved.authToken).toBe('tok-123');
    });

    it('expiresIn berilmasa — standart 24 soat ishlatiladi', async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      (mockedAxios.post as jest.Mock).mockResolvedValue({
        data: { token: 'tok-456' },
      });

      const result = await svc.login('hosp-1', {
        serialNumber: 'ABC123',
        authId: 'auth-xyz',
        pkcs7: 'signed-blob',
      });

      const hoursDiff =
        (result.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursDiff).toBeGreaterThan(23.9);
      expect(hoursDiff).toBeLessThan(24.1);
    });

    it("token bo'lmasa — BadGatewayException", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      (mockedAxios.post as jest.Mock).mockResolvedValue({ data: {} });

      await expect(
        svc.login('hosp-1', {
          serialNumber: 'ABC123',
          authId: 'a',
          pkcs7: 'p',
        }),
      ).rejects.toThrow(BadGatewayException);
    });
  });

  describe('getStatus', () => {
    it("credential yo'q bo'lsa — connected: false", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      const status = await svc.getStatus('hosp-1');
      expect(status).toEqual({
        connected: false,
        hasToken: false,
        serialNumber: null,
        tokenExpiresAt: null,
      });
    });

    it("token muddati o'tgan bo'lsa — hasToken: false, lekin connected: true", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      prisma.__state.set('hosp-1', {
        serialNumber: 'ABC123',
        authToken: 'old-token',
        tokenExpiresAt: new Date(Date.now() - 1000),
      });

      const status = await svc.getStatus('hosp-1');
      expect(status.connected).toBe(true);
      expect(status.hasToken).toBe(false);
    });

    it("amaldagi token bo'lsa — hasToken: true", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      prisma.__state.set('hosp-1', {
        serialNumber: 'ABC123',
        authToken: 'valid-token',
        tokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      });

      const status = await svc.getStatus('hosp-1');
      expect(status.hasToken).toBe(true);
    });
  });

  describe('disconnect', () => {
    it("credential yo'q bo'lsa — NotFoundException", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      await expect(svc.disconnect('hosp-1')).rejects.toThrow(NotFoundException);
    });

    it("mavjud credential o'chiriladi", async () => {
      const svc = new DidoxService(makeConfig() as any, prisma as any);
      prisma.__state.set('hosp-1', { serialNumber: 'ABC123' });

      const result = await svc.disconnect('hosp-1');
      expect(result).toEqual({ disconnected: true });
      expect(prisma.__state.has('hosp-1')).toBe(false);
    });
  });
});
