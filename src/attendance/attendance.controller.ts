import {
  Body, Controller, Get, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}

  @Get('daily')
  getDailyAttendance(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('date') date?: string,
    @Query('departmentId') departmentId?: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.getDailyAttendance(
      date || new Date().toISOString().slice(0, 10),
      departmentId,
      hospitalId,
    );
  }

  @Get('my')
  getMyAttendance(
    @CurrentUser('sub') userId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.service.getMyAttendance(
      userId,
      +month || new Date().getMonth() + 1,
      +year || new Date().getFullYear(),
    );
  }

  @Get('employee/:id')
  getEmployeeAttendance(
    @Param('id') id: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.service.getEmployeeAttendance(id, +month || new Date().getMonth() + 1, +year || new Date().getFullYear());
  }

  @Get('weekly-stats/:employeeId')
    getWeeklyStats(
    @Param('employeeId') employeeId: string,
    @Query('weekStart') weekStart: string,
  ) {
    return this.service.getWeeklyStats(employeeId, weekStart);
  }

  @Post('manual-checkin')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  manualCheckIn(
    @Body() body: { employeeId: string; checkInTime: string; note?: string },
  ) {
    return this.service.manualCheckIn(body.employeeId, body.checkInTime, body.note);
  }

  @Post('mark-absent')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  markAbsent() {
    return this.service.markAbsentForToday();
  }
}
