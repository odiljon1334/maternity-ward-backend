import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';

class SendTelegramDto {
  @IsOptional()
  hospitalIds?: string[] | 'all';

  @IsString()
  message: string;
}

// Har bir endpointda takrorlanmasligi uchun kichik helper
type Scope = { userId: string; hospitalId: string | null; role: UserRole };

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  findAll(
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
  ) {
    const scope: Scope = { userId, hospitalId, role };
    return this.service.findAll(scope, {
      unreadOnly: unreadOnly === 'true',
      limit: limit ? Number(limit) : 50,
    });
  }

  @Get('unread-count')
  unreadCount(
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    const scope: Scope = { userId, hospitalId, role };
    return this.service.unreadCount(scope);
  }

  @Put('read-all')
  markAllRead(
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    const scope: Scope = { userId, hospitalId, role };
    return this.service.markAllRead(scope);
  }

  @Put(':id/read')
  markRead(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    const scope: Scope = { userId, hospitalId, role };
    return this.service.markRead(id, scope);
  }

  // Faqat admin darajasidagilar notification o'chira oladi
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // Telegram broadcast — faqat SUPER_ADMIN/ASSISTANT_ADMIN
  @Post('send-telegram')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  sendTelegram(@Body() dto: SendTelegramDto) {
    return this.service.sendTelegram({
      hospitalIds: dto.hospitalIds || 'all',
      message: dto.message,
    });
  }
}
