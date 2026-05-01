import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SchedulesModule } from '../schedules/schedules.module';

@Module({
  imports: [AttendanceModule, TelegramModule, SchedulesModule],
  providers: [CronService],
})
export class CronModule {}
