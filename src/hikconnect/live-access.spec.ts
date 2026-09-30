import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  decideMediaMtxAccess,
  isPrivateIp,
  streamPathCandidates,
} from './live-access';
import { LiveAccessController } from './live-access.controller';

describe('Kamera oqimi kirish nazorati', () => {
  describe('decideMediaMtxAccess', () => {
    const withPass = {
      MEDIAMTX_PUBLISH_USER: 'publisher',
      MEDIAMTX_PUBLISH_PASS: 's3cret',
    } as NodeJS.ProcessEnv;

    it("parol sozlanmagan bo'lsa — eski xulq, agent loginsiz yuboradi", () => {
      expect(decideMediaMtxAccess({ action: 'publish' }, {})).toBe(true);
    });

    it("parol sozlangan bo'lsa — faqat to'g'ri login bilan yuboriladi", () => {
      expect(decideMediaMtxAccess({ action: 'publish' }, withPass)).toBe(false);
      expect(
        decideMediaMtxAccess(
          { action: 'publish', user: 'publisher', password: 'xato' },
          withPass,
        ),
      ).toBe(false);
      expect(
        decideMediaMtxAccess(
          { action: 'publish', user: 'publisher', password: 's3cret' },
          withPass,
        ),
      ).toBe(true);
    });

    it("o'qish — faqat ichki tarmoqdan (nginx), internetdan yopiq", () => {
      expect(
        decideMediaMtxAccess({ action: 'read', ip: '172.18.0.5' }, {}),
      ).toBe(true);
      expect(decideMediaMtxAccess({ action: 'read', ip: '8.8.8.8' }, {})).toBe(
        false,
      );
      expect(
        decideMediaMtxAccess({ action: 'playback', ip: '185.1.2.3' }, {}),
      ).toBe(false);
      expect(
        decideMediaMtxAccess({ action: 'read', ip: '8.8.8.8' }, {
          MEDIAMTX_ALLOW_PUBLIC_READ: 'true',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });

    it('api/metrics/pprof — rad', () => {
      for (const action of ['api', 'metrics', 'pprof', undefined]) {
        expect(decideMediaMtxAccess({ action, ip: '127.0.0.1' }, {})).toBe(
          false,
        );
      }
    });
  });

  it('isPrivateIp', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.9.9',
      '192.168.1.1',
      '127.0.0.1',
      '::1',
      '::ffff:172.20.0.3',
      'fd00::1',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '185.10.20.30', '', null, 'x']) {
      expect(isPrivateIp(ip as string)).toBe(false);
    }
  });

  it('streamPathCandidates', () => {
    expect(streamPathCandidates('/live/h1/cam1/index.m3u8?x=1')).toEqual([
      'h1',
      'h1/cam1',
      'h1/cam1/index.m3u8',
    ]);
    expect(streamPathCandidates('/uploads/a')).toEqual([]);
    expect(streamPathCandidates('/live/../secret')).toEqual([]);
    expect(streamPathCandidates(undefined)).toEqual([]);
  });

  describe('LiveAccessController', () => {
    const camera = { hospitalId: 'h1' };
    function make(found: unknown = camera, assigned: unknown = null) {
      const prisma: any = {
        camera: { findFirst: jest.fn().mockResolvedValue(found) },
        hospitalAssistant: { findFirst: jest.fn().mockResolvedValue(assigned) },
      };
      return { prisma, controller: new LiveAccessController(prisma) };
    }
    const uri = '/live/h1/cam1/index.m3u8';

    it("o'z muassasasi direktori ko'ra oladi", async () => {
      const { controller, prisma } = make();
      await expect(
        controller.liveAuth(uri, {
          sub: 'u',
          role: 'DIRECTOR',
          hospitalId: 'h1',
        }),
      ).resolves.toBeUndefined();
      expect(prisma.camera.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            streamPath: { in: ['h1', 'h1/cam1', 'h1/cam1/index.m3u8'] },
            isActive: true,
          },
        }),
      );
    });

    it("begona muassasa direktori va oddiy xodim ko'ra olmaydi", async () => {
      await expect(
        make().controller.liveAuth(uri, {
          sub: 'u',
          role: 'DIRECTOR',
          hospitalId: 'h2',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        make().controller.liveAuth(uri, {
          sub: 'u',
          role: 'EMPLOYEE',
          hospitalId: 'h1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ASSISTANT_ADMIN — faqat biriktirilgan muassasa', async () => {
      await expect(
        make(camera, { hospitalId: 'h1' }).controller.liveAuth(uri, {
          sub: 'a',
          role: 'ASSISTANT_ADMIN',
          hospitalId: null,
        }),
      ).resolves.toBeUndefined();
      await expect(
        make(camera, null).controller.liveAuth(uri, {
          sub: 'a',
          role: 'ASSISTANT_ADMIN',
          hospitalId: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("ro'yxatda yo'q oqim va /live/ dan tashqari yo'l — rad", async () => {
      await expect(
        make(null).controller.liveAuth(uri, {
          sub: 's',
          role: 'SUPER_ADMIN',
          hospitalId: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        make().controller.liveAuth('/api/v1/x', {
          sub: 's',
          role: 'SUPER_ADMIN',
          hospitalId: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('MediaMTX endpointi nginx orqali (X-Forwarded-For) yoki tashqi IP dan — 404', () => {
      const { controller } = make();
      const req = (headers: Record<string, string>, remoteAddress: string) =>
        ({ headers, socket: { remoteAddress } }) as any;
      expect(() =>
        controller.mediaMtxAuth(
          req({ 'x-forwarded-for': '1.2.3.4' }, '172.18.0.2'),
          { action: 'read', ip: '172.18.0.2' },
        ),
      ).toThrow(NotFoundException);
      expect(() =>
        controller.mediaMtxAuth(req({}, '8.8.8.8'), {
          action: 'read',
          ip: '172.18.0.2',
        }),
      ).toThrow(NotFoundException);
      expect(
        controller.mediaMtxAuth(req({}, '172.18.0.9'), {
          action: 'read',
          ip: '172.18.0.2',
        }),
      ).toEqual({ ok: true });
      expect(() =>
        controller.mediaMtxAuth(req({}, '172.18.0.9'), {
          action: 'read',
          ip: '8.8.8.8',
        }),
      ).toThrow(UnauthorizedException);
    });
  });
});
