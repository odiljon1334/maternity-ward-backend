import { Test, TestingModule } from '@nestjs/testing';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { LocationGateway } from './location.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { TelegramService } from '../telegram/telegram.service';

/**
 * Bu testlar production'dagi eng muhim ikkita mantiqni tekshiradi:
 *  1) Ish vaqti tugagan / check-out qilingan xodim uchun GPS kuzatish
 *     avtomatik to'xtatilishi (backend tomondan, PWA keshidan qat'iy nazar).
 *  2) Xodim geofence'dan tashqariga chiqsa — FAQAT ketma-ket 2 marta
 *     tasdiqlangandan keyin (bitta tasodifiy GPS sakrashda emas) directorga
 *     xabar yuborilishi.
 *
 * Haqiqiy Postgres kerak emas — barcha bog'liqliklar soxta (fake) obyektlar.
 */
describe('LocationController.updateLiveLocation', () => {
  let controller: LocationController;

  const mockEmployee = {
    id: 'emp-1',
    fullName: 'Test Xodim',
    photoUrl: null,
    hospitalId: 'hosp-1',
    gpsLat: 41.31,
    gpsLng: 69.28,
    gpsRadius: 200,
    department: { name: "Bo'lim" },
    position: { name: 'Lavozim', gpsLat: null, gpsLng: null, gpsRadius: null },
    hospital: { name: 'Hospital', gpsLat: null, gpsLng: null, gpsRadius: null },
  };

  const currentUser = { sub: 'user-1', hospitalId: 'hosp-1' };
  const baseDto = { latitude: 41.31, longitude: 69.28, accuracy: 10 };

  let prisma: any;
  let locationService: any;
  let locationGateway: any;
  let pushService: any;
  let telegramService: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ employee: mockEmployee }),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue({
          checkIn: new Date(),
          checkOut: null,
          expectedCheckOut: new Date(Date.now() + 60 * 60 * 1000), // 1 soatdan keyin
        }),
      },
    };

    locationService = {
      getDistance: jest.fn((lat1, lng1, lat2, lng2) => {
        // Test uchun: koordinatalar bir xil bo'lsa 0, aks holda katta masofa
        return lat1 === lat2 && lng1 === lng2 ? 0 : 5000;
      }),
      getPreviousLocation: jest.fn().mockResolvedValue(null),
      saveLiveLocation: jest.fn().mockResolvedValue({
        id: 'loc-1',
        createdAt: new Date(),
      }),
    };

    locationGateway = {
      broadcastLocation: jest.fn(),
      broadcastLocationRemoved: jest.fn(),
    };

    pushService = {
      notifyGeofenceViolation: jest.fn().mockResolvedValue(true),
      notifyMockLocation: jest.fn().mockResolvedValue(true),
    };

    telegramService = {
      notifyGeofenceAlert: jest.fn().mockResolvedValue(undefined),
      notifyMockLocation: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocationController],
      providers: [
        { provide: LocationService, useValue: locationService },
        { provide: LocationGateway, useValue: locationGateway },
        { provide: PrismaService, useValue: prisma },
        { provide: PushService, useValue: pushService },
        { provide: TelegramService, useValue: telegramService },
      ],
    }).compile();

    controller = module.get(LocationController);
  });

  it("check-out qilingan xodim uchun GPS saqlanmaydi va 'stopTracking' qaytadi", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      checkIn: new Date(Date.now() - 2 * 60 * 60 * 1000),
      checkOut: new Date(),
      expectedCheckOut: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await controller.updateLiveLocation(
      currentUser as any,
      baseDto as any,
    );

    expect(res).toEqual({
      ok: false,
      stopTracking: true,
      reason: 'Check-out qilingan',
    });
    expect(locationService.saveLiveLocation).not.toHaveBeenCalled();
    expect(locationGateway.broadcastLocationRemoved).toHaveBeenCalledWith(
      'hosp-1',
      'user-1',
    );
  });

  it("faol check-in bo'lmasa GPS qabul qilinmaydi", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue(null);

    const res = await controller.updateLiveLocation(
      currentUser as any,
      baseDto as any,
    );

    expect(res).toEqual({
      ok: false,
      stopTracking: true,
      reason: 'Faol check-in topilmadi',
    });
    expect(locationService.saveLiveLocation).not.toHaveBeenCalled();
  });

  it('tungi smena uchun tracking-session avvalgi kun ochiq davomatini davom ettiradi', async () => {
    const checkIn = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const expectedCheckOut = new Date(Date.now() + 3 * 60 * 60 * 1000);
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      checkIn,
      checkOut: null,
      expectedCheckOut,
      status: 'PRESENT',
    });

    const res = await controller.getTrackingSession(currentUser as any);

    expect(res).toEqual({
      active: true,
      checkIn,
      expectedCheckOut,
      reason: null,
      heartbeatMs: 180_000,
    });
    expect(prisma.attendanceRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          employeeId: 'emp-1',
          checkIn: { not: null },
          checkOut: null,
        }),
      }),
    );
  });

  it("ish vaqti tugagan (check-out qilinmagan) xodim uchun ham to'xtatiladi", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      checkIn: new Date(Date.now() - 8 * 60 * 60 * 1000),
      checkOut: null,
      expectedCheckOut: new Date(Date.now() - 5 * 60 * 1000), // 5 daqiqa oldin tugagan
    });

    const res = await controller.updateLiveLocation(
      currentUser as any,
      baseDto as any,
    );

    expect(res.ok).toBe(false);
    expect(res.stopTracking).toBe(true);
    expect(res.reason).toBe('Ish vaqti tugagan');
    expect(locationService.saveLiveLocation).not.toHaveBeenCalled();
    expect(locationGateway.broadcastLocationRemoved).toHaveBeenCalled();
  });

  it("ish vaqti ichida, geofence ichida — oddiy saqlanadi, ogohlantirish yo'q", async () => {
    const res = await controller.updateLiveLocation(
      currentUser as any,
      baseDto as any,
    );

    expect(res).toEqual({ ok: true });
    expect(locationService.saveLiveLocation).toHaveBeenCalledWith(
      'user-1',
      baseDto,
      false,
    );
    expect(pushService.notifyGeofenceViolation).not.toHaveBeenCalled();
    expect(telegramService.notifyGeofenceAlert).not.toHaveBeenCalled();
  });

  it("WebSocket lokatsiya xabarida xodimning ish joyi ma'lumotlari yuboriladi", async () => {
    await controller.updateLiveLocation(currentUser as any, baseDto as any);

    expect(locationGateway.broadcastLocation).toHaveBeenCalledWith(
      'hosp-1',
      expect.objectContaining({
        userId: 'user-1',
        positionName: 'Lavozim',
        departmentName: "Bo'lim",
        hospitalName: 'Hospital',
        isStale: false,
        trackingStatus: 'ONLINE',
      }),
    );
  });

  it("BITTA marta geofence tashqarisida — hali ogohlantirilmaydi (tasodifiy sakrash bo'lishi mumkin)", async () => {
    locationService.getPreviousLocation.mockResolvedValue({ isOutside: false });
    const outsideDto = { latitude: 41.5, longitude: 69.5, accuracy: 10 };

    const res = await controller.updateLiveLocation(
      currentUser as any,
      outsideDto as any,
    );

    expect(res).toEqual({ ok: true });
    expect(locationService.saveLiveLocation).toHaveBeenCalledWith(
      'user-1',
      outsideDto,
      true,
    );
    expect(pushService.notifyGeofenceViolation).not.toHaveBeenCalled();
  });

  it("GPS aniqligi past bo'lsa noaniq nuqta geofence violation hisoblanmaydi", async () => {
    // Markazdan ~4.4 km (haqiqiy haversine), aniqlik ±6 km — noaniqlik
    // doirasi geofence'ni qoplaydi, violation emas.
    const inaccurateDto = {
      latitude: 41.35,
      longitude: 69.28,
      accuracy: 6000,
    };

    await controller.updateLiveLocation(
      currentUser as any,
      inaccurateDto as any,
    );

    expect(locationService.saveLiveLocation).toHaveBeenCalledWith(
      'user-1',
      inaccurateDto,
      false,
    );
    expect(pushService.notifyGeofenceViolation).not.toHaveBeenCalled();
  });

  it('KETMA-KET 2-marta geofence tashqarisida — directorga push + Telegram xabar yuboriladi', async () => {
    locationService.getPreviousLocation.mockResolvedValue({ isOutside: true });
    const outsideDto = { latitude: 41.5, longitude: 69.5, accuracy: 10 };

    await controller.updateLiveLocation(currentUser as any, outsideDto as any);

    // async fire-and-forget zanjiri tugashini kutish
    await new Promise((r) => setImmediate(r));

    expect(pushService.notifyGeofenceViolation).toHaveBeenCalledWith(
      'hosp-1',
      'emp-1',
      'Test Xodim',
      expect.any(Number),
    );
    expect(telegramService.notifyGeofenceAlert).toHaveBeenCalled();
  });

  it("cooldown ichida bo'lsa (PushService false qaytarsa) — Telegram xabar yubormaydi", async () => {
    locationService.getPreviousLocation.mockResolvedValue({ isOutside: true });
    pushService.notifyGeofenceViolation.mockResolvedValue(false);
    const outsideDto = { latitude: 41.5, longitude: 69.5, accuracy: 10 };

    await controller.updateLiveLocation(currentUser as any, outsideDto as any);
    await new Promise((r) => setImmediate(r));

    expect(pushService.notifyGeofenceViolation).toHaveBeenCalled();
    expect(telegramService.notifyGeofenceAlert).not.toHaveBeenCalled();
  });

  it('soxta joylashuv (mocked) — nuqta saqlanmaydi, xaritadan olinadi, rahbariyat ogohlantiriladi', async () => {
    const res = await controller.updateLiveLocation(
      currentUser as any,
      { ...baseDto, mocked: true } as any,
    );
    await new Promise((r) => setImmediate(r));

    expect(res).toEqual({ ok: false, reason: 'MOCK_LOCATION' });
    expect(locationService.saveLiveLocation).not.toHaveBeenCalled();
    expect(locationGateway.broadcastLocation).not.toHaveBeenCalled();
    expect(locationGateway.broadcastLocationRemoved).toHaveBeenCalledWith(
      'hosp-1',
      'user-1',
    );
    expect(pushService.notifyMockLocation).toHaveBeenCalledWith(
      'hosp-1',
      'emp-1',
      'Test Xodim',
      'TRACKING',
    );
    expect(telegramService.notifyMockLocation).toHaveBeenCalled();
  });

  it("ish vaqti tugagan bo'lsa mocked nuqta ham faqat stopTracking qaytaradi (ogohlantirishsiz)", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue(null);
    const res = await controller.updateLiveLocation(
      currentUser as any,
      { ...baseDto, mocked: true } as any,
    );
    expect(res).toMatchObject({ ok: false, stopTracking: true });
    expect(pushService.notifyMockLocation).not.toHaveBeenCalled();
  });
});
