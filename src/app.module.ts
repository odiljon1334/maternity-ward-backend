import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { DepartmentsModule } from './departments/departments.module';
import { PositionsModule } from './positions/positions.module';
import { EmployeesModule } from './employees/employees.module';
import { ShiftsModule } from './shifts/shifts.module';
import { SchedulesModule } from './schedules/schedules.module';
import { AttendanceModule } from './attendance/attendance.module';
import { PayrollModule } from './payroll/payroll.module';
import { TelegramModule } from './telegram/telegram.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { CronModule } from './cron/cron.module';
import { ReportsModule } from './reports/reports.module';
import { HospitalsModule } from './hospitals/hospitals.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { MinistryModule } from './ministry/ministry.module';
import { HikConnectModule } from './hikconnect/hikconnect.module';
import { HealthModule } from './health/health.module';
import { LeaveModule } from './leave/leave.module';
import { PushModule } from './push/push.module';
import { BirthdayModule } from './birthday/birthday.module';

@Module({
  imports: [
    // Config — .env loading
    ConfigModule.forRoot({ isGlobal: true }),

    // Rate limiting — faqat login endpoint uchun (auth.controller.ts da @UseGuards)
    // Barcha boshqa endpointlar JWT bilan himoyalangan + Nginx rate limit bor
    ThrottlerModule.forRoot([
      { name: 'login', ttl: 900_000, limit: 10 }, // 10 urinish / 15 daqiqa
    ]),

    // Cron scheduler
    ScheduleModule.forRoot(),

    // Database
    PrismaModule,

    // Feature modules
    AuthModule,
    DepartmentsModule,
    PositionsModule,
    EmployeesModule,
    ShiftsModule,
    SchedulesModule,
    AttendanceModule,
    PayrollModule,
    TelegramModule,
    DashboardModule,
    CronModule,
    ReportsModule,
    HospitalsModule,
    NotificationsModule,
    PaymentsModule,
    AuditLogModule,
    MinistryModule,
    HikConnectModule,
    HealthModule,
    LeaveModule,
    PushModule,
    BirthdayModule,
  ],
  providers: [],
})
export class AppModule {}
