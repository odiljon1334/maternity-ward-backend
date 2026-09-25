import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AttendanceNoticesController } from './attendance-notices.controller';
import { AttendanceNoticesService } from './attendance-notices.service';

@Module({
  imports: [PrismaModule, TelegramModule, NotificationsModule],
  controllers: [AttendanceNoticesController],
  providers: [AttendanceNoticesService],
  exports: [AttendanceNoticesService],
})
export class AttendanceNoticesModule {}
