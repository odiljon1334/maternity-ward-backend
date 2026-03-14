import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [AttendanceModule, TelegramModule],
  providers: [CronService],
})
export class CronModule {}
