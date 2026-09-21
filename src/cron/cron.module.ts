import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { LeaveModule } from '../leave/leave.module';
import { PushModule } from '../push/push.module';
import { PaymentsModule } from '../payments/payments.module';
import { HikvisionModule } from '../hikvision/hikvision.module';

@Module({
  imports: [
    AttendanceModule,
    TelegramModule,
    SchedulesModule,
    LeaveModule,
    PushModule,
    PaymentsModule,
    HikvisionModule,
  ],
  providers: [CronService],
})
export class CronModule {}
