import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.DEPARTMENT_HEAD)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // GET /api/v1/reports/attendance/excel?month=3&year=2026&departmentId=xxx
  @Get('attendance/excel')
  async attendanceExcel(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('departmentId') departmentId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.reportsService.generateAttendanceExcel({
      month: parseInt(month) || new Date().getMonth() + 1,
      year: parseInt(year) || new Date().getFullYear(),
      departmentId: departmentId || undefined,
    });

    const filename = `davomat-${year}-${String(month).padStart(2, '0')}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  // GET /api/v1/reports/payroll/excel?month=3&year=2026
  @Get('payroll/excel')
  async payrollExcel(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('departmentId') departmentId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.reportsService.generatePayrollExcel({
      month: parseInt(month) || new Date().getMonth() + 1,
      year: parseInt(year) || new Date().getFullYear(),
      departmentId: departmentId || undefined,
    });

    const filename = `maosh-${year}-${String(month).padStart(2, '0')}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  // GET /api/v1/reports/attendance/weekly?weekStart=2026-03-10&departmentId=xxx
  @Get('attendance/weekly')
  async weeklyExcel(
    @Query('weekStart') weekStart: string,
    @Query('departmentId') departmentId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.reportsService.generateWeeklyExcel({
      weekStart: weekStart || new Date().toISOString().slice(0, 10),
      departmentId: departmentId || undefined,
    });

    const filename = `haftalik-${weekStart}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }
}
