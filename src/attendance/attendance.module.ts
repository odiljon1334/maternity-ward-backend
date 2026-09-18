import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { HikvisionWebhookController } from './hikvision-webhook.controller';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { TelegramModule } from '../telegram/telegram.module';
import { LocationModule } from '../location/location.module';
import { FaceMatchModule } from '../face-match/face-match.module';

@Module({
  imports: [NestScheduleModule.forRoot(), TelegramModule, LocationModule, FaceMatchModule],
  controllers: [AttendanceController, HikvisionWebhookController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
