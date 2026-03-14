import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  getOverview() { return this.service.getOverview(); }

  @Get('trend')
  getAttendanceTrend(@Query('days') days: string) {
    return this.service.getAttendanceTrend(+days || 30);
  }

  @Get('departments')
  getDepartmentStats(@Query('month') month: string, @Query('year') year: string) {
    const now = new Date();
    return this.service.getDepartmentStats(+month || now.getMonth() + 1, +year || now.getFullYear());
  }

  @Get('top-late')
  getTopLate(@Query('month') month: string, @Query('year') year: string, @Query('limit') limit: string) {
    const now = new Date();
    return this.service.getTopLateEmployees(+month || now.getMonth() + 1, +year || now.getFullYear(), +limit || 10);
  }
}
