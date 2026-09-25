import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShiftSwapsController } from './shift-swaps.controller';
import { ShiftSwapsService } from './shift-swaps.service';

@Module({
  imports: [PrismaModule, TelegramModule, NotificationsModule],
  controllers: [ShiftSwapsController],
  providers: [ShiftSwapsService],
})
export class ShiftSwapsModule {}
