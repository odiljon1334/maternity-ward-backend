import { ConflictException, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { normalizePinfl } from '../common/utils/pinfl.util';

/**
 * JSHSHIR (PINFL): ixtiyoriy, 14 raqam, muassasa ichida takrorlanmaydi,
 * faqat kadrlar/rahbariyat so'raganda qaytariladi.
 */
describe('Xodim JSHSHIR (PINFL)', () => {
  it('format: bo‘sh — null, bo‘shliq/chiziqcha olib tashlanadi, 14 raqam shart', () => {
    expect(normalizePinfl(undefined)).toEqual({ ok: true, value: null });
    expect(normalizePinfl('')).toEqual({ ok: true, value: null });
    expect(normalizePinfl('3120 5850 2000-23')).toEqual({
      ok: true,
      value: '31205850200023',
    });
    expect(normalizePinfl('123')).toEqual({ ok: false });
    expect(normalizePinfl('3120585020002A')).toEqual({ ok: false });
  });

  it('DTO: maydon ixtiyoriy, noto‘g‘ri format rad etiladi', async () => {
    const base = {
      fullName: 'Test Xodim',
      gender: 'FEMALE',
      departmentId: 'd',
      positionId: 'p',
    };
    const errorsFor = async (pinfl?: unknown) =>
      validate(plainToInstance(CreateEmployeeDto, { ...base, pinfl }));

    expect(await errorsFor(undefined)).toHaveLength(0);
    expect(await errorsFor('')).toHaveLength(0);
    expect(await errorsFor('3120 5850 2000 23')).toHaveLength(0);
    const bad = await errorsFor('12345');
    expect(bad[0]?.constraints?.matches).toBe(
      "JSHSHIR 14 ta raqamdan iborat bo'lishi kerak",
    );
  });

  function setup(taken: { fullName: string } | null = null) {
    const created: any[] = [];
    const tx: any = {
      user: { findUnique: jest.fn(), create: jest.fn() },
      employee: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return { id: 'new', ...data };
        }),
      },
    };
    const prisma: any = {
      department: { findFirst: jest.fn(async () => ({ id: 'd' })) },
      position: { findFirst: jest.fn(async () => ({ id: 'p' })) },
      employee: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => taken),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    return {
      prisma,
      created,
      svc: new EmployeesService(prisma, {} as any),
    };
  }
  const dto = (pinfl?: string) =>
    ({
      fullName: 'Test Xodim',
      gender: 'FEMALE',
      departmentId: 'd',
      positionId: 'p',
      pinfl,
    }) as any;

  it('saqlanadi; JSHSHIR’siz xodim ham yaratiladi', async () => {
    const { svc, created } = setup();
    await svc.create(dto('31205850200023'), 'h1');
    await svc.create(dto(undefined), 'h1');
    expect(created[0].pinfl).toBe('31205850200023');
    expect(created[1].pinfl).toBeUndefined();
  });

  it('muassasada boshqa xodimda bo‘lsa — rad etiladi', async () => {
    const { svc } = setup({ fullName: 'Boshqa Xodim' });
    await expect(svc.create(dto('31205850200023'), 'h1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('noto‘g‘ri formatdagi qiymat serviceda ham o‘tmaydi', async () => {
    const { svc } = setup();
    await expect(svc.create(dto('99'), 'h1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('kartochkada faqat ruxsatli rolga so‘raladi', async () => {
    const { svc, prisma } = setup();
    prisma.employee.findFirst = jest.fn(async () => ({ id: 'e1' }));

    await svc.findOne('e1', 'h1');
    expect(prisma.employee.findFirst.mock.calls[0][0].omit).toBeUndefined();

    await svc.findOne('e1', 'h1', { withPinfl: true });
    expect(prisma.employee.findFirst.mock.calls[1][0].omit).toEqual({
      pinfl: false,
    });
  });
});
