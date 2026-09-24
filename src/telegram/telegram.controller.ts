import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Body,
  Headers,
  Query,
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
import { TelegramAccessService } from './telegram-access.service';
import { SetBotAccessDto } from './dto/set-bot-access.dto';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { UserRole } from '@prisma/client';

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
    private readonly access: TelegramAccessService,
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
    if (!expected) {
      // Productionda secret'siz webhook qabul qilinmaydi (fail-closed):
      // aks holda istalgan kishi soxta update (masalan to'lov) yubora oladi.
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException('Webhook secret not configured');
      }
      return; // dev/o'tish davri
    }
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

  // ── HR botga ulanish ruxsati (allowlist) ─────────────────────────────────
  // DIRECTOR/ADMIN — faqat o'z muassasasi (JWT). ASSISTANT_ADMIN — faqat
  // biriktirilgan muassasa (TenantScopeGuard user.hospitalId'ni tasdiqlab
  // almashtiradi). SUPER_ADMIN — `hospitalId` ni aniq yuborishi shart.

  /** GET /telegram/bot-access?hospitalId= */
  @Get('bot-access')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.DIRECTOR,
    UserRole.ADMIN,
  )
  listBotAccess(
    @CurrentUser() user: { role: UserRole; hospitalId?: string | null },
    @Query('hospitalId') hospitalId?: string,
  ) {
    return this.access.list(this.resolveHospitalId(user, hospitalId));
  }

  /** PUT /telegram/bot-access/:employeeId  { enabled, hospitalId? } */
  @Put('bot-access/:employeeId')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.DIRECTOR,
    UserRole.ADMIN,
  )
  setBotAccess(
    @CurrentUser() user: { role: UserRole; hospitalId?: string | null },
    @Param('employeeId') employeeId: string,
    @Body() dto: SetBotAccessDto,
  ) {
    return this.access.setAccess(
      this.resolveHospitalId(user, dto.hospitalId),
      employeeId,
      dto.enabled,
    );
  }

  /** DELETE /telegram/bot-access/subscriptions/:id?hospitalId= */
  @Delete('bot-access/subscriptions/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.DIRECTOR,
    UserRole.ADMIN,
  )
  revokeBotSubscription(
    @CurrentUser() user: { role: UserRole; hospitalId?: string | null },
    @Param('id') id: string,
    @Query('hospitalId') hospitalId?: string,
  ) {
    return this.access.revokeSubscription(
      this.resolveHospitalId(user, hospitalId),
      id,
    );
  }

  private resolveHospitalId(
    user: { role: UserRole; hospitalId?: string | null },
    requested?: string,
  ): string {
    if (user.role === UserRole.SUPER_ADMIN) {
      if (!requested) throw new BadRequestException('hospitalId kerak');
      return requested;
    }
    // Boshqa rollar uchun so'rovdagi qiymat E'TIBORGA OLINMAYDI.
    if (!user.hospitalId) {
      throw new ForbiddenException('Muassasa aniqlanmadi');
    }
    return user.hospitalId;
  }
}
