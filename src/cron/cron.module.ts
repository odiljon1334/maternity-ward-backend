import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { LeaveModule } from 'src/leave/leave.module';
import { PushModule } from 'src/push/push.module';

@Module({
  imports: [
    AttendanceModule,
    TelegramModule,
    SchedulesModule,
    LeaveModule,
    PushModule,
  ],
  providers: [CronService],
})
export class CronModule {}
