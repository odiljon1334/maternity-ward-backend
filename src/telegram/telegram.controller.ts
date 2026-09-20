import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from './telegram.service';
import { UserRole } from '@prisma/client';

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  /** POST /telegram/webhook — JWT guard YO'Q! */
  @Post('webhook')
  async handleWebhook(
    @Body() update: any,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ) {
    this.assertValidWebhookSecret(secret);
    await this.telegramService.handleUpdate(update);
    return { ok: true };
  }

  private assertValidWebhookSecret(provided?: string) {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!expected) return; // O'tish davri: BotFather webhook sozlamasi hali yangilanmagan bo'lishi mumkin.
    const actual = Buffer.from(provided ?? '');
    const wanted = Buffer.from(expected);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }
  }

  /** GET /telegram/status */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  async status(@CurrentUser('hospitalId') hospitalId: string | null) {
    if (!hospitalId) return { active: false, count: 0 };
    const count = await this.prisma.telegramSubscription.count({
      where: { hospitalId, isActive: true },
    });
    return { active: count > 0, count };
  }

  /** GET /telegram/subscriptions — SUPER_ADMIN */
  @Get('subscriptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async getAllSubscriptions() {
    const hospitals = await this.prisma.hospital.findMany({
      select: { id: true, name: true, address: true },
      orderBy: { name: 'asc' },
    });
    const subs = await this.prisma.telegramSubscription.findMany({
      include: { hospital: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
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
