import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceNoticesService } from './attendance-notices.service';
import { applyNoticeExcuse, unexcusedLate } from './notice-excuse.util';

const employee = {
  id: 'e1',
  hospitalId: 'h1',
  fullName: 'Karimova Dilnoza',
  firedAt: null,
};
const notice = (over: any = {}) => ({
  id: 'n1',
  employeeId: 'e1',
  hospitalId: 'h1',
  status: 'PENDING',
  reason: 'TRAFFIC',
  delayMinutes: 30,
  comment: null,
  workDate: new Date('2026-09-25T19:00:00Z'),
  employee: {
    id: 'e1',
    fullName: 'Karimova Dilnoza',
    userId: 'u1',
    telegramChatId: '555',
    telegramReminders: true,
    position: null,
    department: null,
  },
  ...over,
});

function setup(
  o: { record?: any; existing?: any; found?: any; updated?: number } = {},
) {
  const prisma: any = {
    employee: { findUnique: jest.fn(async () => employee) },
    user: { findUnique: jest.fn(async () => ({ employee: { id: 'e1' } })) },
    attendanceRecord: {
      findFirst: jest.fn(async () => o.record ?? null),
      update: jest.fn(async (a: any) => a),
    },
    attendanceNotice: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.status?.in) return o.existing ?? null; // dublikat tekshiruvi
        if (where.status === 'APPROVED') return { id: 'n1' }; // excuse util
        return o.found === undefined ? notice() : o.found;
      }),
      create: jest.fn(async (a: any) => notice({ ...a.data })),
      updateMany: jest.fn(async () => ({ count: o.updated ?? 1 })),
      findMany: jest.fn(async () => []),
    },
    schedule: {
      findFirst: jest.fn(async () => ({ shift: { startTime: '08:00' } })),
    },
  };
  const telegram: any = {
    registerDecisionHandler: jest.fn(),
    notifyAttendanceNotice: jest.fn(async () => {}),
    sendPersonal: jest.fn(async () => true),
  };
  const push: any = {
    sendToHospital: jest.fn(async () => ['m1']),
    sendToUser: jest.fn(async () => {}),
  };
  const notifications: any = {
    createForUsers: jest.fn(async () => {}),
    create: jest.fn(async () => {}),
  };
  const svc = new AttendanceNoticesService(
    prisma,
    telegram,
    push,
    notifications,
  );
  return { svc, prisma, telegram, push };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('AttendanceNoticesService', () => {
  it('xabar yaratiladi va rahbarlarga (Telegram + push) yuboriladi', async () => {
    const { svc, prisma, telegram, push } = setup();
    await svc.create('u1', {
      reason: 'TRAFFIC' as any,
      delayMinutes: 30,
      comment: '  Yo‘l tirband  ',
    });
    await flush();
    expect(prisma.attendanceNotice.create.mock.calls[0][0].data).toMatchObject({
      employeeId: 'e1',
      hospitalId: 'h1',
      delayMinutes: 30,
      comment: 'Yo‘l tirband',
    });
    expect(telegram.notifyAttendanceNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMinutes: 30,
        shiftStart: '08:00',
        reason: "Yo'l tirband",
      }),
    );
    expect(push.sendToHospital).toHaveBeenCalled();
  });

  it('bir kunda ikkinchi xabar — 409; ish kuni yakunlangan — 400', async () => {
    await expect(
      setup({ existing: { id: 'x' } }).svc.create('u1', {
        reason: 'OTHER' as any,
        delayMinutes: 10,
      }),
    ).rejects.toThrow(ConflictException);
    await expect(
      setup({ record: { checkOut: new Date() } }).svc.create('u1', {
        reason: 'OTHER' as any,
        delayMinutes: 10,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('tasdiqlash — kechikish uzrli bo‘ladi (tushlik kechikishi kirmaydi), xodimga xabar', async () => {
    const { svc, prisma, telegram } = setup({
      record: {
        id: 'r1',
        checkIn: new Date(),
        lateMinutes: 45,
        lunchLateMin: 10,
        excusedLateMin: 0,
      },
    });
    const res = await svc.review('n1', 'APPROVED', {
      userId: 'd1',
      hospitalId: 'h1',
    });
    await flush();
    expect(res.excusedLateMin).toBe(35);
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { excusedLateMin: 35 },
    });
    expect(telegram.sendPersonal).toHaveBeenCalledWith(
      '555',
      expect.stringContaining('uzrli'),
    );
  });

  it('rad etish — uzr qo‘llanmaydi', async () => {
    const { svc, prisma } = setup({
      record: {
        id: 'r1',
        checkIn: new Date(),
        lateMinutes: 45,
        lunchLateMin: 0,
        excusedLateMin: 0,
      },
    });
    await svc.review(
      'n1',
      'REJECTED',
      { userId: 'd1', hospitalId: 'h1' },
      'Sabab yetarli emas',
    );
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('boshqa muassasa xabari topilmaydi; allaqachon ko‘rilgan — 409', async () => {
    await expect(
      setup({ found: null }).svc.review('n1', 'APPROVED', {
        userId: 'd1',
        hospitalId: 'h2',
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      setup({ updated: 0 }).svc.review('n1', 'APPROVED', {
        userId: 'd1',
        hospitalId: 'h1',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('Telegram tugmasi: obunasiz chat rad etiladi, xato matn qaytadi (yiqilmaydi)', async () => {
    const { svc } = setup({ found: null });
    expect(
      await svc.reviewFromTelegram('n1', 'APPROVED', {
        hospitalId: null,
        employeeId: null,
      }),
    ).toContain("Ruxsat yo'q");
    expect(
      await svc.reviewFromTelegram('n1', 'APPROVED', {
        hospitalId: 'h2',
        employeeId: null,
      }),
    ).toContain('topilmadi');
  });

  it('bekor qilish — faqat PENDING', async () => {
    await expect(setup({ updated: 0 }).svc.cancel('u1', 'n1')).rejects.toThrow(
      BadRequestException,
    );
    expect(await setup().svc.cancel('u1', 'n1')).toEqual({ cancelled: true });
  });
});

describe('notice-excuse.util', () => {
  it('tasdiqlangan xabar yo‘q yoki xodim hali kelmagan — o‘zgarish yo‘q', async () => {
    const prisma: any = {
      attendanceNotice: { findFirst: jest.fn(async () => null) },
      attendanceRecord: { findFirst: jest.fn(), update: jest.fn() },
    };
    expect(await applyNoticeExcuse(prisma, 'e1', new Date())).toBeNull();
    prisma.attendanceNotice.findFirst.mockResolvedValue({ id: 'n1' });
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      id: 'r1',
      checkIn: null,
    });
    expect(await applyNoticeExcuse(prisma, 'e1', new Date())).toBeNull();
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('uzrsiz kechikish = lateMinutes − excusedLateMin', () => {
    expect(unexcusedLate({ lateMinutes: 45, excusedLateMin: 35 })).toBe(10);
    expect(unexcusedLate({ lateMinutes: 10 })).toBe(10);
  });
});
