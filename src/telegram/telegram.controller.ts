import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';

@Controller('telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /telegram/status
   * Returns whether the current user's hospital has an active Telegram subscription.
   */
  @Get('status')
  async status(@CurrentUser('hospitalId') hospitalId: string | null) {
    if (!hospitalId) {
      return { active: false, count: 0 };
    }

    const count = await this.prisma.telegramSubscription.count({
      where: {
        hospitalId,
        isActive: true,
      },
    });

    return { active: count > 0, count };
  }

  /**
   * GET /telegram/subscriptions
   * SuperAdmin uchun: barcha kasalxonalarning Telegram ulanish holati.
   */
  @Get('subscriptions')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async getAllSubscriptions() {
    // Barcha kasalxonalarni olish
    const hospitals = await this.prisma.hospital.findMany({
      select: { id: true, name: true, address: true },
      orderBy: { name: 'asc' },
    });

    // Barcha subscriptionlarni olish
    const subs = await this.prisma.telegramSubscription.findMany({
      include: { hospital: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Har bir kasalxona uchun subscription holatini birlashtirish
    return hospitals.map((h) => {
      const hospitalSubs = subs.filter((s) => s.hospitalId === h.id);
      const activeSubs = hospitalSubs.filter((s) => s.isActive);
      return {
        hospitalId: h.id,
        hospitalName: h.name,
        address: h.address,
        isConnected: activeSubs.length > 0,
        activeCount: activeSubs.length,
        subscriptions: hospitalSubs.map((s) => ({
          id: s.id,
          chatId: s.chatId,
          username: s.username,
          role: s.role,
          isActive: s.isActive,
          createdAt: s.createdAt,
        })),
      };
    });
  }
}
