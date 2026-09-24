import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SchedulesService } from '../schedules/schedules.service';
import { EmployeesService } from '../employees/employees.service';
import { PayrollService } from '../payroll/payroll.service';
import { AttendanceService } from '../attendance/attendance.service';
import { canManageRole } from './utils/role-rank.util';
import { isBlockExemptRequest, JwtAuthGuard } from './guards/jwt-auth.guard';
import { tokenFromCookie, verifySocketUser } from './utils/ws-auth.util';
import { clearHospitalBlockCache } from './utils/payment.util';

/**
 * 3-paket: tenant (muassasa) chegaralari va huquq teshiklari.
 * Har bir test ilgari ishlagan hujum yo'lini yopilganini tekshiradi.
 */

describe('Schedules — boshqa muassasa smenasi/xodimi', () => {
  function setup(extra: any = {}) {
    const prisma: any = {
      employee: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'emp-b'
            ? { id: 'emp-b', hospitalId: 'hB' }
            : { id: where.id, hospitalId: 'hA' },
        ),
        findMany: jest.fn(async () => [{ id: 'emp-a', hospitalId: 'hA' }]),
      },
      shiftTemplate: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.hospitalId
            ? { id: `${where.hospitalId}-${where.type}`, ...where }
            : { id: 'foreign-global', hospitalId: 'hB', type: where.type },
        ),
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'shift-b'
            ? { id: 'shift-b', hospitalId: 'hB', type: 'DAYTIME' }
            : { id: where.id, hospitalId: 'hA', type: 'DAYTIME' },
        ),
        count: jest.fn(
          async ({ where }: any) =>
            where.id.in.filter((id: string) => id !== 'shift-b').length,
        ),
      },
      schedule: {
        findFirst: jest.fn(async () => ({
          id: 'sch-1',
          sourcePlanId: null,
          employee: { hospitalId: 'hA' },
        })),
        update: jest.fn(async (a: any) => a),
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({ count: 0 })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      ...extra,
    };
    return { prisma, svc: new SchedulesService(prisma) };
  }

  it("updateEntry faqat shiftId/status/note'ni yozadi (employeeId/date/sourcePlanId emas)", async () => {
    const { prisma, svc } = setup();
    await svc.updateEntry(
      'sch-1',
      {
        status: 'WORKING',
        note: 'ok',
        employeeId: 'emp-b',
        date: '2020-01-01',
        sourcePlanId: 'x',
      } as any,
      'hA',
    );
    expect(prisma.schedule.update).toHaveBeenCalledWith({
      where: { id: 'sch-1' },
      data: { status: 'WORKING', note: 'ok' },
    });
  });

  it('updateEntry boshqa muassasa smenasini rad etadi', async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.updateEntry('sch-1', { shiftId: 'shift-b' }, 'hA'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.schedule.update).not.toHaveBeenCalled();
  });

  it("updateEntry noto'g'ri holatni rad etadi", async () => {
    const { svc } = setup();
    await expect(
      svc.updateEntry('sch-1', { status: 'HACKED' as any }, 'hA'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('generate boshqa muassasa dayShiftId bilan ishlamaydi', async () => {
    const { svc } = setup();
    await expect(
      svc.generate(
        {
          employeeId: 'emp-a',
          month: 9,
          year: 2026,
          pattern: 'FIXED_DAY' as any,
          dayShiftId: 'shift-b',
        },
        'hA',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('generate boshqa muassasa smenasiga global fallback qilmaydi', async () => {
    const { prisma, svc } = setup();
    await svc
      .generate(
        {
          employeeId: 'emp-a',
          month: 9,
          year: 2026,
          pattern: 'FIXED_DAY' as any,
        },
        'hA',
      )
      .catch(() => undefined);
    for (const [args] of prisma.shiftTemplate.findFirst.mock.calls) {
      expect(args.where.hospitalId).toBe('hA');
    }
  });

  it('bulkGenerate employeeIds orqali boshqa muassasa xodimiga yozmaydi', async () => {
    const { svc } = setup();
    const res: any[] = await svc.bulkGenerate({
      employeeIds: ['emp-b'],
      month: 9,
      year: 2026,
      pattern: 'FIXED_DAY' as any,
      hospitalId: 'hA',
    } as any);
    expect(res[0].error).toMatch(/boshqa muassasa/);
  });

  it('bulkManual boshqa muassasa smenasini rad etadi', async () => {
    const { svc } = setup();
    await expect(
      svc.bulkManual(
        {
          employeeIds: ['emp-a'],
          entries: [{ date: '2026-09-01', shiftId: 'shift-b' }],
        } as any,
        'hA',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Rollar ierarxiyasi', () => {
  it('ADMIN direktorni boshqara olmaydi, direktor ADMINni boshqaradi', () => {
    expect(canManageRole('ADMIN', 'DIRECTOR')).toBe(false);
    expect(canManageRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canManageRole('DIRECTOR', 'ADMIN')).toBe(true);
    expect(canManageRole('ADMIN', 'EMPLOYEE')).toBe(true);
    expect(canManageRole('ASSISTANT_ADMIN', 'DIRECTOR')).toBe(true);
    expect(canManageRole('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(canManageRole('ADMIN', null)).toBe(true);
  });
});

describe('Employees — direktor hisobini ADMIN o‘zgartira olmaydi', () => {
  function setup(role = 'DIRECTOR') {
    const tx: any = {
      employee: {
        findUnique: jest.fn(async () => ({ userId: 'u-dir' })),
        update: jest.fn(async () => ({ id: 'e1' })),
      },
      user: {
        findFirst: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
      },
    };
    const prisma: any = {
      employee: {
        findFirst: jest.fn(async () => ({
          id: 'e1',
          hospitalId: 'hA',
          userId: 'u-dir',
          user: { id: 'u-dir', username: 'direktor', role },
        })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    return { tx, svc: new EmployeesService(prisma, {} as any) };
  }

  it('ADMIN direktor parolini almashtira olmaydi', async () => {
    const { svc, tx } = setup();
    await expect(
      svc.update('e1', { password: 'Yangi12345' } as any, 'hA', 'ADMIN'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("ADMIN direktorning telefonini o'zgartira oladi (forma eski username'ni qayta yuborsa ham)", async () => {
    const { svc, tx } = setup();
    await svc.update(
      'e1',
      { phone: '+998900000000', username: 'direktor' } as any,
      'hA',
      'ADMIN',
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.employee.update).toHaveBeenCalled();
  });

  it('DIRECTOR xodim parolini almashtirsa eski sessiyalar bekor bo‘ladi', async () => {
    const { svc, tx } = setup('EMPLOYEE');
    await svc.update('e1', { password: 'Yangi12345' } as any, 'hA', 'DIRECTOR');
    const data = tx.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toBeTruthy();
    expect(data.credentialsChangedAt).toBeInstanceOf(Date);
  });

  it('ADMIN direktorni ishdan bo‘shata olmaydi', async () => {
    const { svc } = setup();
    await expect(
      svc.fire('e1', 'hA', undefined, undefined, undefined, 'ADMIN'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Payroll va davomat — muassasa chegarasi', () => {
  it('approve boshqa muassasa yozuvini topmaydi', async () => {
    const prisma: any = {
      payrollRecord: {
        findFirst: jest.fn(async () => null),
        update: jest.fn(),
      },
    };
    const svc = new PayrollService(prisma, {} as any);
    await expect(svc.approve('p1', 'hA')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.payrollRecord.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', employee: { hospitalId: 'hA' } },
    });
    expect(prisma.payrollRecord.update).not.toHaveBeenCalled();
  });

  it('manualCheckIn boshqa muassasa xodimi uchun 404', async () => {
    const svc: any = Object.create(AttendanceService.prototype);
    svc.prisma = { employee: { findFirst: jest.fn(async () => null) } };
    await expect(
      svc.manualCheckIn('emp-b', new Date().toISOString(), undefined, 'hA'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(svc.prisma.employee.findFirst).toHaveBeenCalledWith({
      where: { id: 'emp-b', hospitalId: 'hA' },
    });
  });

  it('manualCheckIn kelajakdagi vaqtni rad etadi', async () => {
    const svc: any = Object.create(AttendanceService.prototype);
    svc.prisma = {
      employee: { findFirst: jest.fn(async () => ({ id: 'e' })) },
    };
    const future = new Date(Date.now() + 3600_000).toISOString();
    await expect(
      svc.manualCheckIn('e', future, undefined, 'hA'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Hikvision webhook: boshqa muassasa terminali eventi rad etiladi', async () => {
    const svc: any = Object.create(AttendanceService.prototype);
    svc.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn() };
    svc.prisma = {
      employee: {
        findUnique: jest.fn(async () => ({ id: 'e', hospitalId: 'hA' })),
      },
      hikTerminal: {
        findUnique: jest.fn(async () => ({ hospitalId: 'hB' })),
      },
      hospital: { findUnique: jest.fn() },
    };
    const res = await svc.processHikvisionEvent({
      employeeNo: '100',
      deviceId: 'dev-b',
      eventTime: new Date().toISOString(),
    });
    expect(res).toBeNull();
    expect(svc.prisma.hospital.findUnique).not.toHaveBeenCalled();
  });
});

describe('Bloklangan muassasa — faqat o‘qish rejimi', () => {
  const ctx = (method: string, url: string, user: any) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method, originalUrl: url, user }),
      }),
    }) as any;

  beforeEach(() => {
    clearHospitalBlockCache();
    jest
      .spyOn(AuthGuard('jwt').prototype, 'canActivate')
      .mockResolvedValue(true as never);
  });
  afterEach(() => jest.restoreAllMocks());

  function guard(isBlocked: boolean) {
    const prisma: any = {
      hospital: {
        findUnique: jest.fn(async () => ({
          isBlocked,
          createdAt: new Date('2025-01-01'),
        })),
      },
    };
    return { prisma, g: new JwtAuthGuard(prisma) };
  }

  it('istisno yo‘llar: GET, auth, payments', () => {
    expect(isBlockExemptRequest('GET', '/api/v1/employees')).toBe(true);
    expect(isBlockExemptRequest('POST', '/api/v1/auth/logout')).toBe(true);
    expect(isBlockExemptRequest('POST', '/api/v1/payments/invoice?x=1')).toBe(
      true,
    );
    expect(isBlockExemptRequest('POST', '/api/v1/employees')).toBe(false);
    expect(isBlockExemptRequest('PUT', '/api/v1/paymentsx/1')).toBe(false);
  });

  it('bloklangan muassasa direktori yozuv qila olmaydi', async () => {
    const { g } = guard(true);
    await expect(
      g.canActivate(
        ctx('POST', '/api/v1/employees', {
          role: 'DIRECTOR',
          hospitalId: 'hA',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("bloklangan muassasa ma'lumotni o'qiy oladi va to'lov qila oladi", async () => {
    const { g, prisma } = guard(true);
    const u = { role: 'DIRECTOR', hospitalId: 'hA' };
    await expect(
      g.canActivate(ctx('GET', '/api/v1/employees', u)),
    ).resolves.toBe(true);
    await expect(
      g.canActivate(ctx('POST', '/api/v1/payments/invoices', u)),
    ).resolves.toBe(true);
    expect(prisma.hospital.findUnique).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN va bloklanmagan muassasa odatdagidek', async () => {
    const { g } = guard(false);
    await expect(
      g.canActivate(
        ctx('POST', '/api/v1/employees', { role: 'ADMIN', hospitalId: 'hA' }),
      ),
    ).resolves.toBe(true);
    const b = guard(true);
    await expect(
      b.g.canActivate(
        ctx('POST', '/api/v1/employees', {
          role: 'SUPER_ADMIN',
          hospitalId: null,
        }),
      ),
    ).resolves.toBe(true);
  });
});

describe('WebSocket autentifikatsiyasi', () => {
  const jwt: any = {
    verifyAsync: jest.fn(async (t: string) => {
      if (t === 'bad') throw new Error('invalid');
      return { sub: 'u1', iat: 1_000 };
    }),
  };
  const prismaWith = (user: any) =>
    ({ user: { findUnique: jest.fn(async () => user) } }) as any;

  it('cookie token o‘qiladi', () => {
    expect(tokenFromCookie('a=1; access_token=abc%2E1; b=2')).toBe('abc.1');
    expect(tokenFromCookie('')).toBeNull();
  });

  it('imzo xato / foydalanuvchi faol emas / parol almashgan — rad', async () => {
    expect(await verifySocketUser(jwt, prismaWith(null), 'bad')).toBeNull();
    expect(await verifySocketUser(jwt, prismaWith(null), null)).toBeNull();
    expect(
      await verifySocketUser(
        jwt,
        prismaWith({ id: 'u1', role: 'ADMIN', status: 'SUSPENDED' }),
        'ok',
      ),
    ).toBeNull();
    expect(
      await verifySocketUser(
        jwt,
        prismaWith({
          id: 'u1',
          role: 'ADMIN',
          status: 'ACTIVE',
          credentialsChangedAt: new Date(2_000_000),
        }),
        'ok',
      ),
    ).toBeNull();
  });

  it('faol foydalanuvchi qabul qilinadi', async () => {
    const u = await verifySocketUser(
      jwt,
      prismaWith({
        id: 'u1',
        role: 'DIRECTOR',
        status: 'ACTIVE',
        hospitalId: 'hA',
        credentialsChangedAt: null,
      }),
      'ok',
    );
    expect(u).toEqual({ id: 'u1', role: 'DIRECTOR', hospitalId: 'hA' });
  });
});
