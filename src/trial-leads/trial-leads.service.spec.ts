import { NotFoundException } from '@nestjs/common';
import { TrialLeadSource, TrialLeadStatus } from '@prisma/client';
import { TrialLeadsService } from './trial-leads.service';

function makeService() {
  const prisma: any = {
    trialLead: {
      create: jest.fn(async ({ data }) => ({ id: 'lead-1', ...data })),
      findMany: jest.fn().mockResolvedValue([{ id: 'lead-1' }]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([
        { status: TrialLeadStatus.NEW, _count: { _all: 3 } },
        { status: TrialLeadStatus.CONVERTED, _count: { _all: 1 } },
      ]),
      findUnique: jest.fn().mockResolvedValue({ id: 'lead-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(async ({ data }) => ({ id: 'lead-1', ...data })),
    },
  };
  return { service: new TrialLeadsService(prisma), prisma };
}

describe('TrialLeadsService', () => {
  it('veb-forma leadini NEW holatda saqlash uchun Prisma ga uzatadi', async () => {
    const { service, prisma } = makeService();

    await service.capture({
      source: TrialLeadSource.WEB_FORM,
      institutionName: 'Test klinika',
      contactName: 'Ali Valiyev',
      phone: '+998901234567',
      staffCount: 25,
    });

    expect(prisma.trialLead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: TrialLeadSource.WEB_FORM,
        institutionName: 'Test klinika',
        phone: '+998901234567',
      }),
    });
  });

  it("qidiruv va filtrlarni bitta ro'yxat so'roviga birlashtiradi", async () => {
    const { service, prisma } = makeService();

    const result = await service.findAll({
      search: 'klinika',
      source: TrialLeadSource.TELEGRAM_BOT,
      status: TrialLeadStatus.NEW,
      page: 2,
      limit: 10,
    });

    expect(prisma.trialLead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: expect.objectContaining({
          source: TrialLeadSource.TELEGRAM_BOT,
          status: TrialLeadStatus.NEW,
          OR: expect.any(Array),
        }),
      }),
    );
    expect(result.meta).toEqual({
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });
  });

  it("statistikada mavjud bo'lmagan statuslarni ham nol bilan qaytaradi", async () => {
    const { service } = makeService();

    const stats = await service.getStats();

    expect(stats.total).toBe(4);
    expect(stats.byStatus.NEW).toBe(3);
    expect(stats.byStatus.CONVERTED).toBe(1);
    expect(stats.byStatus.REJECTED).toBe(0);
  });

  it('statusni va tozalangan izohni yangilaydi', async () => {
    const { service, prisma } = makeService();

    await service.updateStatus(
      'lead-1',
      TrialLeadStatus.CONTACTED,
      "  Ertaga qo'ng'iroq qilish  ",
    );

    expect(prisma.trialLead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: {
        status: TrialLeadStatus.CONTACTED,
        note: "Ertaga qo'ng'iroq qilish",
      },
    });
  });

  it("mavjud bo'lmagan lead statusini o'zgartirmaydi", async () => {
    const { service, prisma } = makeService();
    prisma.trialLead.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStatus('missing', TrialLeadStatus.REJECTED),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.trialLead.update).not.toHaveBeenCalled();
  });

  it('Telegramdagi birinchi murojaatni darhol LEAD sifatida saqlaydi', async () => {
    const { service, prisma } = makeService();

    const result = await service.captureTelegramContact({
      chatId: '12345',
      username: 'ali_user',
      displayName: 'Ali Valiyev',
      firstMessage: "Narxlari haqida ma'lumot bering",
    });

    expect(result.created).toBe(true);
    expect(prisma.trialLead.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: TrialLeadSource.TELEGRAM_BOT,
        telegramChatId: '12345',
        telegramUsername: 'ali_user',
        contactName: 'Ali Valiyev',
        institutionName: 'Telegram orqali murojaat',
        phone: 'Kiritilmagan',
        note: "Birinchi xabar: Narxlari haqida ma'lumot bering",
      }),
    });
  });

  it('takroriy Telegram xabarida yangi LEAD yaratmaydi', async () => {
    const { service, prisma } = makeService();
    prisma.trialLead.findFirst.mockResolvedValue({
      id: 'existing-lead',
      contactName: 'Ali Valiyev',
      note: 'Birinchi xabar: Salom',
    });

    const result = await service.captureTelegramContact({
      chatId: '12345',
      username: 'ali_new',
      displayName: 'Ali Valiyev',
      firstMessage: 'Yana savolim bor',
    });

    expect(result.created).toBe(false);
    expect(prisma.trialLead.create).not.toHaveBeenCalled();
    expect(prisma.trialLead.update).toHaveBeenCalledWith({
      where: { id: 'existing-lead' },
      data: { telegramUsername: 'ali_new' },
    });
  });

  it("trial anketa tugaganda avvalgi Telegram LEADni to'ldiradi", async () => {
    const { service, prisma } = makeService();
    prisma.trialLead.findFirst.mockResolvedValue({ id: 'existing-lead' });

    await service.completeTelegramLead({
      chatId: '12345',
      username: 'ali_user',
      institutionName: 'Test klinika',
      contactName: 'Ali Valiyev',
      phone: '+998901234567',
      staffCount: 20,
    });

    expect(prisma.trialLead.create).not.toHaveBeenCalled();
    expect(prisma.trialLead.update).toHaveBeenCalledWith({
      where: { id: 'existing-lead' },
      data: expect.objectContaining({
        institutionName: 'Test klinika',
        contactName: 'Ali Valiyev',
        phone: '+998901234567',
        staffCount: 20,
      }),
    });
  });
});
