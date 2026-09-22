import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { PayrollModule } from '../payroll/payroll.module';

@Module({
  imports: [AttendanceModule, PayrollModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
