import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { HikvisionWebhookController } from './hikvision-webhook.controller';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [NestScheduleModule.forRoot()],
  controllers: [AttendanceController, HikvisionWebhookController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
