import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { LocationGateway } from '../location/location.gateway';
import { FaceMatchService } from '../face-match/face-match.service';
import { AuditLogService } from '../audit-log/audit-log.service';

jest.mock('../common/utils/payment.util', () => ({
  isHospitalBlocked: jest.fn().mockResolvedValue(false),
}));
jest.mock('../common/utils/image.util', () => ({
  processAndSavePhoto: jest.fn().mockResolvedValue({ filename: 'x.jpg', sizeKb: 10 }),
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
      employee: { findUnique: jest.fn().mockResolvedValue({ baseSalary: 3000000 }) },
    };

    faceMatch = { verify: jest.fn() };
    auditLog = { log: jest.fn() };
    telegram = { notifyMobileCheckin: jest.fn().mockResolvedValue(undefined) };

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
      ],
    }).compile();

    service = module.get(AttendanceService);
  });

  it("ANIQ MOS KELMASLIK — check-in rad etiladi, AttendanceRecord YARATILMAYDI (GPS kuzatish boshlanmaydi)", async () => {
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

  it("mos keldi (skipped:false, mismatch:false) — check-in davom etadi, AttendanceRecord yaratiladi", async () => {
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

  it("xizmat ishlamadi (skipped:true, fail-open) — check-in BLOKLANMAYDI, davom etadi", async () => {
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

  it("selfie yuborilmagan bo'lsa — face-match umuman chaqirilmaydi", async () => {
    await service.selfCheckIn('user-1', dto as any, undefined);
    expect(faceMatch.verify).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.create).toHaveBeenCalled();
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
});
