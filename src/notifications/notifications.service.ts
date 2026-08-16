import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  async findAll(params?: { unreadOnly?: boolean; limit?: number }) {
    const where: any = {};
    if (params?.unreadOnly) where.isRead = false;

    return this.prisma.notification.findMany({
      where,
      include: { hospital: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      take: params?.limit || 100,
    });
  }

  async unreadCount(): Promise<number> {
    return this.prisma.notification.count({ where: { isRead: false } });
  }

  async markRead(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead() {
    return this.prisma.notification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });
  }

  async remove(id: string) {
    return this.prisma.notification.delete({ where: { id } });
  }

  async create(data: {
    type: NotificationType;
    title: string;
    message: string;
    hospitalId?: string | null;
    metadata?: any;
  }) {
    return this.prisma.notification.create({ data });
  }

  /**
   * SUPER_ADMIN tomonidan Telegram xabar yuborish
   * hospitalIds: konket ID lar | 'all' — hamma kasalxonalar
   */
  async sendTelegram(data: { hospitalIds: string[] | 'all'; message: string }) {
    const { hospitalIds, message } = data;

    let subs: { chatId: string; hospitalId: string | null }[];

    if (hospitalIds === 'all') {
      subs = await this.prisma.telegramSubscription.findMany({
        where: { isActive: true, hospitalId: { not: null } },
        select: { chatId: true, hospitalId: true },
      });
    } else {
      subs = await this.prisma.telegramSubscription.findMany({
        where: {
          isActive: true,
          hospitalId: { in: hospitalIds },
        },
        select: { chatId: true, hospitalId: true },
      });
    }

    const uniqueChats = [...new Map(subs.map((s) => [s.chatId, s])).values()];

    let sentCount = 0;
    for (const sub of uniqueChats) {
      try {
        await this.telegram.sendToChat(
          sub.chatId,
          `📢 <b>MaternityCare xabarnomasi</b>\n\n${message}`,
        );
        sentCount++;
      } catch {
        /* skip failed */
      }
    }

    // Notification yozuvi yaratish
    const hospitalLabel = hospitalIds === 'all' ? null : undefined;
    await this.create({
      type: NotificationType.SYSTEM,
      title: 'Telegram xabar yuborildi',
      message: `${sentCount} ta direktorga: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`,
      hospitalId: null,
    });

    return { sentCount };
  }
}
