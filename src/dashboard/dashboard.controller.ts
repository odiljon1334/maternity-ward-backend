import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  getOverview(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('date') date?: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    // SUPER_ADMIN sends targetHospitalId; others use JWT hospitalId
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.getOverview({ date, hospitalId });
  }

  @Get('trend')
  getAttendanceTrend(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('days') days?: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.getAttendanceTrend(+(days || 14), hospitalId);
  }

  @Get('departments')
  getDepartmentStats(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const now = new Date();
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.getDepartmentStats(
      +(month || now.getMonth() + 1),
      +(year || now.getFullYear()),
      hospitalId,
    );
  }

  @Get('top-late')
  getTopLate(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('limit') limit?: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.getTopLateEmployees(+(limit || 5), hospitalId);
  }
}
