import { Module } from '@nestjs/common';
import { SentryModule } from '@sentry/nestjs/setup';
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
import { HikvisionModule } from './hikvision/hikvision.module';
import { LocationModule } from './location/location.module';
import { UsersModule } from './users/users.module';
import { DidoxModule } from './didox/didox.module';
import { PublicModule } from './public/public.module';

@Module({
  imports: [
    // Sentry — instrument.ts'da SENTRY_DSN bo'lsa ishga tushadi (Faza 3).
    // Bu HAR DOIM birinchi bo'lib ro'yxatga olinishi tavsiya etiladi.
    SentryModule.forRoot(),

    // Config — .env loading
    ConfigModule.forRoot({ isGlobal: true }),

    // Rate limiting — faqat login endpoint uchun (auth.controller.ts da @UseGuards)
    // Barcha boshqa endpointlar JWT bilan himoyalangan + Nginx rate limit bor
    ThrottlerModule.forRoot([
      { name: 'login', ttl: 900_000, limit: 10 }, // 10 urinish / 15 daqiqa
      { name: 'public', ttl: 3_600_000, limit: 5 }, // ochiq (marketing) endpointlar — 5 so'rov / soat / IP
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
    PublicModule,
    DashboardModule,
    CronModule,
    ReportsModule,
    HospitalsModule,
    NotificationsModule,
    PaymentsModule,
    AuditLogModule,
    MinistryModule,
    HikConnectModule,
    HikvisionModule,
    HealthModule,
    LeaveModule,
    PushModule,
    BirthdayModule,
    LocationModule,
    UsersModule,
    DidoxModule,
  ],
  providers: [],
})
export class AppModule {}
