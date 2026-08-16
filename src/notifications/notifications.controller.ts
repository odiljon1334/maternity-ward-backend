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
import { UserRole } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';

class SendTelegramDto {
  @IsOptional()
  hospitalIds?: string[] | 'all';

  @IsString()
  message: string;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  findAll(
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll({
      unreadOnly: unreadOnly === 'true',
      limit: limit ? Number(limit) : 50,
    });
  }

  @Get('unread-count')
  unreadCount() {
    return this.service.unreadCount();
  }

  @Put('read-all')
  markAllRead() {
    return this.service.markAllRead();
  }

  @Put(':id/read')
  markRead(@Param('id') id: string) {
    return this.service.markRead(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('send-telegram')
  sendTelegram(@Body() dto: SendTelegramDto) {
    return this.service.sendTelegram({
      hospitalIds: dto.hospitalIds || 'all',
      message: dto.message,
    });
  }
}
