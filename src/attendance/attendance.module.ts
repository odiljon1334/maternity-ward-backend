import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { HikvisionWebhookController } from './hikvision-webhook.controller';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { TelegramModule } from '../telegram/telegram.module';
import { LocationModule } from '../location/location.module';

@Module({
  imports: [NestScheduleModule.forRoot(), TelegramModule, LocationModule],
  controllers: [AttendanceController, HikvisionWebhookController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
