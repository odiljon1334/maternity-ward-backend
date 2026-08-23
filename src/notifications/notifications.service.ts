import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { NotificationType, UserRole } from '@prisma/client';

export interface NotificationScope {
  userId: string;
  hospitalId: string | null;
  role: UserRole;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Foydalanuvchiga ko'rinishi kerak bo'lgan notificationlar:
   *  - userId = shu foydalanuvchi (shaxsiy xabar)
   *  - YOKI userId = null va hospitalId = uning kasalxonasi (kasalxona broadcast)
   *  - SUPER_ADMIN uchun qo'shimcha: userId = null va hospitalId = null (global broadcast)
   */
  private scopeWhere(scope: NotificationScope) {
    const or: any[] = [{ userId: scope.userId }];
    if (scope.hospitalId) {
      or.push({ userId: null, hospitalId: scope.hospitalId });
    }
    if (scope.role === UserRole.SUPER_ADMIN) {
      or.push({ userId: null, hospitalId: null });
    }
    return { OR: or };
  }

  async findAll(
    scope: NotificationScope,
    params?: { unreadOnly?: boolean; limit?: number },
  ) {
    const where: any = this.scopeWhere(scope);
    if (params?.unreadOnly) where.isRead = false;

    return this.prisma.notification.findMany({
      where,
      include: { hospital: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      take: params?.limit || 100,
    });
  }

  async unreadCount(scope: NotificationScope): Promise<number> {
    return this.prisma.notification.count({
      where: { ...this.scopeWhere(scope), isRead: false },
    });
  }

  async markRead(id: string, scope: NotificationScope) {
    const notif = await this.prisma.notification.findUnique({
      where: { id },
    });
    if (!notif) throw new NotFoundException('Notification topilmadi');
    this.assertVisible(notif, scope);

    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead(scope: NotificationScope) {
    return this.prisma.notification.updateMany({
      where: { ...this.scopeWhere(scope), isRead: false },
      data: { isRead: true },
    });
  }

  async remove(id: string) {
    return this.prisma.notification.delete({ where: { id } });
  }

  /** Bitta notification (shaxsiy yoki broadcast) yaratish */
  async create(data: {
    type: NotificationType;
    title: string;
    message: string;
    userId?: string | null;
    hospitalId?: string | null;
    metadata?: any;
  }) {
    return this.prisma.notification.create({ data });
  }

  /** Bir nechta userga bir xil xabarni alohida-alohida yozuv sifatida yaratish */
  async createForUsers(
    userIds: string[],
    data: {
      type: NotificationType;
      title: string;
      message: string;
      metadata?: any;
    },
  ) {
    const uniqueIds = [...new Set(userIds)];
    if (!uniqueIds.length) return { count: 0 };

    return this.prisma.notification.createMany({
      data: uniqueIds.map((userId) => ({ ...data, userId })),
    });
  }

  private assertVisible(
    notif: { userId: string | null; hospitalId: string | null },
    scope: NotificationScope,
  ) {
    if (notif.userId) {
      if (notif.userId !== scope.userId) {
        throw new ForbiddenException('Bu xabar sizga tegishli emas');
      }
      return;
    }
    if (notif.hospitalId) {
      if (notif.hospitalId !== scope.hospitalId) {
        throw new ForbiddenException('Bu xabar sizga tegishli emas');
      }
      return;
    }
    // hospitalId = null && userId = null → global, faqat SUPER_ADMIN
    if (scope.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Bu xabar sizga tegishli emas');
    }
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

    // Notification yozuvi yaratish (global — SUPER_ADMIN uchun)
    await this.create({
      type: NotificationType.SYSTEM,
      title: 'Telegram xabar yuborildi',
      message: `${sentCount} ta direktorga: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`,
      userId: null,
      hospitalId: null,
    });

    return { sentCount };
  }
}
