import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { LocationGateway } from '../location/location.gateway';
import { FaceMatchService } from '../face-match/face-match.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PushService } from '../push/push.service';

jest.mock('../common/utils/payment.util', () => ({
  isHospitalBlocked: jest.fn().mockResolvedValue(false),
}));
jest.mock('../common/utils/image.util', () => ({
  processAndSavePhoto: jest
    .fn()
    .mockResolvedValue({ filename: 'x.jpg', sizeKb: 10 }),
  prepareFaceImage: jest.fn(async (b: Buffer) => b),
}));

/**
 * Qaror 4 — "GPS kuzatish FAQAT yuz tasdiqlangandan keyin boshlanishi kerak"
 * talabini tekshiradi: face-match ANIQ MOS KELMASLIK qaytarsa, selfCheckIn
 * AttendanceRecord yaratishdan OLDIN BadRequestException tashlaydi — demak
 * davomat yozuvi hech qachon yaratilmaydi va shu bilan GPS kuzatish (u
 * davomat yozuvi mavjudligiga bog'liq) hech qachon boshlanmaydi.
 *
 * Haqiqiy Postgres yoki Python face-match mikroservisi kerak emas — barcha
 * bog'liqliklar soxta (fake) obyektlar.
 */
describe('AttendanceService.selfCheckIn — Qaror 4 yuz tekshiruvi gate', () => {
  let service: AttendanceService;
  let prisma: any;
  let faceMatch: any;
  let auditLog: any;
  let telegram: any;
  let push: any;

  const employee = {
    id: 'emp-1',
    fullName: 'Test Xodim',
    hospitalId: 'hosp-1',
    photoUrl: '/uploads/emp1.jpg',
    gpsLat: null,
    gpsLng: null,
    gpsRadius: null,
    baseSalary: 3000000,
    hospital: { gpsLat: null, gpsLng: null, gpsRadius: null },
    department: null,
    position: null,
    workSites: [],
  };

  const dto = { gpsLat: 41.31, gpsLng: 69.28, gpsAccuracy: 10 };
  const selfieBuffer = Buffer.from('fake-selfie-bytes');

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ employee }),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue(null), // hali check-in qilinmagan
        create: jest.fn().mockResolvedValue({ id: 'att-1' }),
        update: jest.fn().mockResolvedValue({ id: 'att-1' }),
      },
      schedule: { findUnique: jest.fn().mockResolvedValue(null) },
      shiftTemplate: { findMany: jest.fn().mockResolvedValue([]) },
      weeklyAttendanceStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      employee: {
        findUnique: jest.fn().mockResolvedValue({ baseSalary: 3000000 }),
      },
      // Jonli kuzatuv: standart holatda — ish joyida, signal yangi
      liveLocation: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({ createdAt: new Date() }),
      },
    };

    faceMatch = { verify: jest.fn() };
    auditLog = { log: jest.fn() };
    telegram = {
      notifyMobileCheckin: jest.fn().mockResolvedValue(undefined),
      notifyMockLocation: jest.fn().mockResolvedValue(undefined),
    };
    push = { notifyMockLocation: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: TelegramService, useValue: telegram },
        {
          provide: LocationGateway,
          useValue: {
            broadcastLocationRemoved: jest.fn(),
            broadcastAttendance: jest.fn(),
          },
        },
        { provide: FaceMatchService, useValue: faceMatch },
        { provide: AuditLogService, useValue: auditLog },
        { provide: PushService, useValue: push },
      ],
    }).compile();

    service = module.get(AttendanceService);
  });

  it('soxta joylashuv (mocked) — rad etiladi, yuz tekshirilmaydi, rahbariyat ogohlantiriladi', async () => {
    await expect(
      service.selfCheckIn(
        'user-1',
        { ...dto, mocked: true, expectedAction: 'CHECK_IN' } as any,
        selfieBuffer,
      ),
    ).rejects.toThrow(/soxta joylashuv/i);
    await new Promise((r) => setImmediate(r));

    expect(faceMatch.verify).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MOCK_LOCATION_REJECTED' }),
    );
    expect(push.notifyMockLocation).toHaveBeenCalledWith(
      'hosp-1',
      'emp-1',
      'Test Xodim',
      'CHECK_IN',
    );
    expect(telegram.notifyMockLocation).toHaveBeenCalled();
  });

  it('ANIQ MOS KELMASLIK — check-in rad etiladi, AttendanceRecord YARATILMAYDI (GPS kuzatish boshlanmaydi)', async () => {
    faceMatch.verify.mockResolvedValue({
      mismatch: true,
      skipped: false,
      reason: 'FACE_MISMATCH',
      similarity: 0.1,
    });

    await expect(
      service.selfCheckIn('user-1', dto as any, selfieBuffer),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FACE_MATCH_REJECTED' }),
    );
  });

  it('mos keldi (skipped:false, mismatch:false) — check-in davom etadi, AttendanceRecord yaratiladi', async () => {
    faceMatch.verify.mockResolvedValue({
      mismatch: false,
      skipped: false,
      similarity: 0.7,
    });

    const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);

    expect(res.action).toBe('CHECK_IN');
    expect(prisma.attendanceRecord.create).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FACE_MATCH_OK' }),
    );
  });

  it("FaceMatchService skipped:true qaytarsa (masalan LENIENT rejimda) — AttendanceService check-in'ni BLOKLAMAYDI", async () => {
    faceMatch.verify.mockResolvedValue({
      mismatch: false,
      skipped: true,
      reason: 'SERVICE_ERROR',
    });

    const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);

    expect(res.action).toBe('CHECK_IN');
    expect(prisma.attendanceRecord.create).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FACE_MATCH_SKIPPED' }),
    );
  });

  it.each(['SERVICE_ERROR', 'NO_REFERENCE_PHOTO', 'REFERENCE_FACE_NOT_FOUND'])(
    'strict rejimda %s — check-in QABUL QILINADI, yuz keyinroq tekshiriladi (faceCheckPending)',
    async (reason) => {
      faceMatch.verify.mockResolvedValue({
        mismatch: true,
        skipped: false,
        reason,
      });

      const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);

      expect(res.action).toBe('CHECK_IN');
      expect(prisma.attendanceRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            faceVerified: false,
            faceCheckPending: true,
            faceCheckReason: reason,
            selfieUrl: '/uploads/selfies/x.jpg',
          }),
        }),
      );
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'FACE_MATCH_DEFERRED' }),
      );
    },
  );

  it('FACE_MATCH_FALLBACK=block — xizmat ishlamasa eski xulq: check-in rad etiladi', async () => {
    process.env.FACE_MATCH_FALLBACK = 'block';
    try {
      faceMatch.verify.mockResolvedValue({
        mismatch: true,
        skipped: false,
        reason: 'SERVICE_ERROR',
      });
      await expect(
        service.selfCheckIn('user-1', dto as any, selfieBuffer),
      ).rejects.toThrow(/vaqtincha ishlamayapti/);
      expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.FACE_MATCH_FALLBACK;
    }
  });

  it('selfida yuz topilmasa (LIVE_FACE_NOT_FOUND) — xodim qayta suratga tushishi kerak, rad etiladi', async () => {
    faceMatch.verify.mockResolvedValue({
      mismatch: true,
      skipped: false,
      reason: 'LIVE_FACE_NOT_FOUND',
    });
    await expect(
      service.selfCheckIn('user-1', dto as any, selfieBuffer),
    ).rejects.toThrow(/yuzingiz aniqlanmadi/);
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it('muvaffaqiyatli tekshiruvda faceCheckPending=false, faceVerified=true', async () => {
    faceMatch.verify.mockResolvedValue({
      mismatch: false,
      skipped: false,
      similarity: 0.8,
    });
    await service.selfCheckIn('user-1', dto as any, selfieBuffer);
    expect(prisma.attendanceRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          faceVerified: true,
          faceCheckPending: false,
          faceCheckReason: null,
        }),
      }),
    );
  });

  it("selfie yuborilmagan check-in RAD ETILADI (yuz tekshiruvini chetlab o'tib bo'lmaydi)", async () => {
    await expect(
      service.selfCheckIn('user-1', dto as any, undefined),
    ).rejects.toThrow(/selfie kerak/);
    expect(faceMatch.verify).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it.each([
    ['koordinatasiz', {}],
    ['faqat kenglik', { gpsLat: 41.31 }],
    ['NaN', { gpsLat: NaN, gpsLng: 69.28 }],
    ['diapazondan tashqari', { gpsLat: 141.31, gpsLng: 69.28 }],
  ])("GPS %s bo'lsa check-in RAD ETILADI", async (_label, badDto) => {
    faceMatch.verify.mockResolvedValue({ mismatch: false, skipped: false });
    await expect(
      service.selfCheckIn('user-1', badDto as any, selfieBuffer),
    ).rejects.toThrow(/Joylashuv aniqlanmadi/);
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it("geofence markazidan uzoqda bo'lsa rad etiladi, ichida bo'lsa o'tadi", async () => {
    faceMatch.verify.mockResolvedValue({ mismatch: false, skipped: false });
    prisma.user.findUnique.mockResolvedValue({
      employee: {
        ...employee,
        hospital: { gpsLat: 41.31, gpsLng: 69.28, gpsRadius: 200 },
      },
    });

    // ~1.1 km shimolda
    await expect(
      service.selfCheckIn(
        'user-1',
        { gpsLat: 41.32, gpsLng: 69.28 } as any,
        selfieBuffer,
      ),
    ).rejects.toThrow(/uzoqdasiz/);
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();

    // ~50 m
    const res = await service.selfCheckIn(
      'user-1',
      { gpsLat: 41.3104, gpsLng: 69.28 } as any,
      selfieBuffer,
    );
    expect(res.action).toBe('CHECK_IN');
  });

  it("bu CHECK_OUT bo'lsa (allaqachon check-in qilingan) — face-match chaqirilmaydi", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      id: 'att-1',
      checkIn: new Date(Date.now() - 8 * 60 * 60 * 1000),
      checkOut: null,
      selfieUrl: null,
      status: 'PRESENT',
      lateMinutes: 0,
      expectedCheckOut: null,
      lunchOut: null,
      lunchIn: null,
    });

    await service.selfCheckIn('user-1', dto as any, selfieBuffer);

    expect(faceMatch.verify).not.toHaveBeenCalled();
  });

  it('ilova CHECK_OUT kutgan, lekin kelish yo‘q — 409 (ko‘r-ko‘rona check-in bo‘lmaydi)', async () => {
    await expect(
      service.selfCheckIn(
        'user-1',
        { ...dto, expectedAction: 'CHECK_OUT' } as any,
        selfieBuffer,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it('kechiktirilgan yuz tekshiruvi auditda bitta DEFERRED yozuv (REJECTED emas)', async () => {
    faceMatch.verify.mockResolvedValue({
      mismatch: true,
      skipped: false,
      reason: 'SERVICE_ERROR',
    });
    const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);
    expect(res.action).toBe('CHECK_IN');
    const actions = auditLog.log.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toEqual(['FACE_MATCH_DEFERRED']);
  });

  describe('tungi smena (yarim tundan keyin)', () => {
    const now = Date.now();
    const overnight = {
      id: 'att-night',
      workDate: new Date(now - 24 * 3600_000),
      checkIn: new Date(now - 6 * 3600_000),
      checkOut: null,
      status: 'PRESENT',
      lateMinutes: 0,
      // kutilgan ketish — 4 soatdan keyin (bugun)
      expectedCheckOut: new Date(now + 4 * 3600_000),
      lunchOut: null,
      lunchIn: null,
    };

    it('bugungi yozuv yo‘q, kechagi ochiq — kechagi yozuv yopiladi (yangi check-in emas)', async () => {
      prisma.attendanceRecord.findFirst
        .mockResolvedValueOnce(null) // bugun
        .mockResolvedValueOnce(overnight); // kechagi ochiq
      const res = await service.selfCheckIn('user-1', dto as any, undefined);
      expect(res.action).toBe('CHECK_OUT');
      expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
      expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'att-night' } }),
      );
    });

    it('kechagi ochiq yozuv kunduzgi smena (ketish kecha edi) — yangi check-in', async () => {
      prisma.attendanceRecord.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...overnight,
          checkIn: new Date(now - 18 * 3600_000),
          expectedCheckOut: new Date(now - 30 * 3600_000),
        });
      faceMatch.verify.mockResolvedValue({ mismatch: false, skipped: false });
      const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);
      expect(res.action).toBe('CHECK_IN');
      expect(prisma.attendanceRecord.create).toHaveBeenCalled();
    });

    it('getSelfToday — tungi smenada CHECK_OUT va overnight=true', async () => {
      prisma.attendanceRecord.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(overnight);
      const st = await service.getSelfToday('user-1');
      expect(st).toMatchObject({
        action: 'CHECK_OUT',
        overnight: true,
        dayOff: false,
      });
      expect(st.record?.id).toBe('att-night');
    });
  });

  it('getSelfToday — dam olish kuni va kelmagan: dayOff=true, CHECK_IN', async () => {
    prisma.schedule.findUnique.mockResolvedValue({
      status: 'DAY_OFF',
      shift: null,
    });
    const st = await service.getSelfToday('user-1');
    expect(st).toMatchObject({
      action: 'CHECK_IN',
      dayOff: true,
      dayOffStatus: 'DAY_OFF',
      record: null,
    });
  });

  describe('CHECK_OUT (4c)', () => {
    const openRecord = {
      id: 'att-1',
      checkIn: new Date(Date.now() - 8 * 60 * 60 * 1000),
      checkOut: null,
      selfieUrl: '/uploads/selfies/checkin.jpg',
      status: 'PRESENT',
      lateMinutes: 0,
      expectedCheckOut: null,
      lunchOut: null,
      lunchIn: null,
    };
    beforeEach(() =>
      prisma.attendanceRecord.findFirst.mockResolvedValue(openRecord),
    );

    it("kuzatuv toza bo'lsa selfisiz ham ketish mumkin, yuz tekshirilmaydi", async () => {
      const res = await service.selfCheckIn('user-1', dto as any, undefined);
      expect(res.action).toBe('CHECK_OUT');
      expect(faceMatch.verify).not.toHaveBeenCalled();
    });

    it('smena davomida tashqarida ko‘rilgan bo‘lsa — yuz tekshiriladi, mos kelmasa rad', async () => {
      prisma.liveLocation.count.mockResolvedValue(2);
      faceMatch.verify.mockResolvedValue({
        mismatch: true,
        skipped: false,
        reason: 'FACE_MISMATCH',
      });
      await expect(
        service.selfCheckIn('user-1', dto as any, selfieBuffer),
      ).rejects.toThrow(/check-out rad etildi/);
      expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
    });

    it('kuzatuv 30 daqiqadan ko‘p uzilgan va selfie yo‘q — rad', async () => {
      prisma.liveLocation.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 60 * 60_000),
      });
      await expect(
        service.selfCheckIn('user-1', dto as any, undefined),
      ).rejects.toThrow(/yuz tekshiruvi kerak/);
    });

    it('shubhali holatda face-match xizmati ishlamasa — ketish BLOKLANMAYDI', async () => {
      prisma.liveLocation.count.mockResolvedValue(1);
      faceMatch.verify.mockResolvedValue({
        mismatch: true,
        skipped: false,
        reason: 'SERVICE_ERROR',
      });
      const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);
      expect(res.action).toBe('CHECK_OUT');
    });

    it("profil rasmi yo'q (kelishda kechiktirilgan) xodim ketishda bloklanmaydi", async () => {
      prisma.liveLocation.count.mockResolvedValue(1);
      faceMatch.verify.mockResolvedValue({
        mismatch: true,
        skipped: false,
        reason: 'NO_REFERENCE_PHOTO',
      });
      const res = await service.selfCheckIn('user-1', dto as any, selfieBuffer);
      expect(res.action).toBe('CHECK_OUT');
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'FACE_MATCH_SKIPPED' }),
      );
    });

    it('ilova CHECK_IN kutgan, lekin kelish allaqachon qayd etilgan — 409, hech narsa yozilmaydi', async () => {
      await expect(
        service.selfCheckIn(
          'user-1',
          { ...dto, expectedAction: 'CHECK_IN' } as any,
          selfieBuffer,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
      expect(faceMatch.verify).not.toHaveBeenCalled();
    });

    it('check-out kelish selfisini ustidan yozmaydi', async () => {
      const { processAndSavePhoto } = jest.requireMock(
        '../common/utils/image.util',
      );
      processAndSavePhoto.mockClear();
      await service.selfCheckIn('user-1', dto as any, selfieBuffer);
      const bases = processAndSavePhoto.mock.calls.map((c: any[]) => c[2]);
      expect(bases.length).toBeGreaterThan(0);
      expect(bases.every((b: string) => b.startsWith('checkout-'))).toBe(true);
    });
  });

  describe('GPS aniqligi (4c)', () => {
    beforeEach(() => {
      faceMatch.verify.mockResolvedValue({ mismatch: false, skipped: false });
      prisma.user.findUnique.mockResolvedValue({
        employee: {
          ...employee,
          hospital: { gpsLat: 41.31, gpsLng: 69.28, gpsRadius: 200 },
        },
      });
    });

    it('~230 m, aniqlik ±40 m — radius+40 ichida, o‘tadi', async () => {
      const res = await service.selfCheckIn(
        'user-1',
        { gpsLat: 41.3121, gpsLng: 69.28, gpsAccuracy: 40 } as any,
        selfieBuffer,
      );
      expect(res.action).toBe('CHECK_IN');
    });

    it('~230 m, aniqlik ±140 m — noaniqlik ko‘pi bilan 50 m olinadi, 250 ichida o‘tadi', async () => {
      const res = await service.selfCheckIn(
        'user-1',
        { gpsLat: 41.3121, gpsLng: 69.28, gpsAccuracy: 140 } as any,
        selfieBuffer,
      );
      expect(res.action).toBe('CHECK_IN');
    });

    it('~280 m, aniqlik ±140 m — 200+50 dan tashqarida, rad', async () => {
      await expect(
        service.selfCheckIn(
          'user-1',
          { gpsLat: 41.3125, gpsLng: 69.28, gpsAccuracy: 140 } as any,
          selfieBuffer,
        ),
      ).rejects.toThrow(/uzoqdasiz/);
    });

    it('aniqlik ±600 m — umuman qabul qilinmaydi', async () => {
      await expect(
        service.selfCheckIn(
          'user-1',
          { gpsLat: 41.31, gpsLng: 69.28, gpsAccuracy: 600 } as any,
          selfieBuffer,
        ),
      ).rejects.toThrow(/aniqligi past/);
    });
  });
});
