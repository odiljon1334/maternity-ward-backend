import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MAX_BOT_ACCESS_PER_HOSPITAL,
  TelegramAccessService,
  phoneKey,
} from './telegram-access.service';

function makePrisma(employee: any, grantedCount = 0) {
  const prisma: any = {
    employee: {
      findFirst: jest.fn(async ({ where }: any) =>
        employee &&
        where.id === employee.id &&
        where.hospitalId === employee.hospitalId
          ? employee
          : null,
      ),
      count: jest.fn(async () => grantedCount),
      update: jest.fn(async (args: any) => args),
    },
    telegramSubscription: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return prisma;
}

const emp = (over: any = {}) => ({
  id: 'e1',
  hospitalId: 'h1',
  phone: '+998 90 123-45-67',
  firedAt: null,
  telegramBotAccess: false,
  ...over,
});

describe('TelegramAccessService', () => {
  it('phoneKey oxirgi 9 raqamni oladi', () => {
    expect(phoneKey('+998 (90) 123-45-67')).toBe('901234567');
    expect(phoneKey('12345')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it("boshqa muassasa xodimiga ruxsat berib bo'lmaydi", async () => {
    const svc = new TelegramAccessService(makePrisma(emp()));
    await expect(svc.setAccess('h2', 'e1', true)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('telefoni yo‘q xodimga ruxsat berilmaydi', async () => {
    const prisma = makePrisma(emp({ phone: null }));
    const svc = new TelegramAccessService(prisma);
    await expect(svc.setAccess('h1', 'e1', true)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it(`limit (${MAX_BOT_ACCESS_PER_HOSPITAL}) to'lgan bo'lsa yangi ruxsat berilmaydi`, async () => {
    const prisma = makePrisma(emp(), MAX_BOT_ACCESS_PER_HOSPITAL);
    const svc = new TelegramAccessService(prisma);
    await expect(svc.setAccess('h1', 'e1', true)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('ruxsat beriladi', async () => {
    const prisma = makePrisma(emp(), 2);
    const svc = new TelegramAccessService(prisma);
    await svc.setAccess('h1', 'e1', true);
    expect(prisma.employee.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { telegramBotAccess: true },
    });
  });

  it('ruxsat olinganda shu xodimning chatlari ham uziladi', async () => {
    const prisma = makePrisma(emp({ telegramBotAccess: true }));
    const svc = new TelegramAccessService(prisma);
    await svc.setAccess('h1', 'e1', false);
    expect(prisma.telegramSubscription.updateMany).toHaveBeenCalledWith({
      where: { employeeId: 'e1', isActive: true },
      data: { isActive: false },
    });
  });

  it("boshqa muassasaning chat ulanishini uzib bo'lmaydi", async () => {
    const prisma = makePrisma(emp());
    prisma.telegramSubscription.updateMany = jest.fn(async () => ({
      count: 0,
    }));
    const svc = new TelegramAccessService(prisma);
    await expect(svc.revokeSubscription('h2', 's1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.telegramSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', hospitalId: 'h2', isActive: true },
      data: { isActive: false },
    });
  });
});
