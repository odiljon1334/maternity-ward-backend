import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { NotificationsService } from './notifications.service';

describe('NotificationsService assistant tenant scope', () => {
  function setup() {
    const prisma = {
      hospitalAssistant: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { hospitalId: 'hospital-1' },
            { hospitalId: 'hospital-2' },
          ]),
      },
      telegramSubscription: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', hospitalId: 'hospital-1' }]),
      },
      notification: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
        delete: jest.fn(),
      },
      user: { findUnique: jest.fn() },
    };
    const telegram = { sendToChat: jest.fn().mockResolvedValue(undefined) };
    return {
      prisma,
      telegram,
      service: new NotificationsService(prisma as never, telegram as never),
    };
  }

  it('maps assistant all broadcast to assigned hospitals only', async () => {
    const { prisma, service } = setup();

    await service.sendTelegram(
      { hospitalIds: 'all', message: 'Test xabar' },
      { userId: 'assistant-1', role: UserRole.ASSISTANT_ADMIN },
    );

    expect(prisma.telegramSubscription.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        hospitalId: { in: ['hospital-1', 'hospital-2'] },
      },
      select: { chatId: true, hospitalId: true },
    });
  });

  it('rejects an assistant broadcast to an unassigned hospital', async () => {
    const { service, telegram } = setup();

    await expect(
      service.sendTelegram(
        { hospitalIds: ['hospital-3'], message: 'Test xabar' },
        { userId: 'assistant-1', role: UserRole.ASSISTANT_ADMIN },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(telegram.sendToChat).not.toHaveBeenCalled();
  });

  it('rejects deleting another tenant notification', async () => {
    const { prisma, service } = setup();
    prisma.notification.findUnique.mockResolvedValue({
      id: 'notification-1',
      userId: null,
      hospitalId: 'hospital-3',
    });

    await expect(
      service.remove('notification-1', {
        userId: 'assistant-1',
        hospitalId: null,
        role: UserRole.ASSISTANT_ADMIN,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.notification.delete).not.toHaveBeenCalled();
  });
});
