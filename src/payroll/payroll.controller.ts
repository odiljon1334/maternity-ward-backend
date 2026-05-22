import {
  Body, Controller, Get, Param, Post, Put, Query,
  UseGuards, Res, StreamableFile,
} from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { Response } from 'express';

@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.ASSISTANT_ADMIN)
  findAll(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    const now = new Date();
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.findAll(+month || now.getMonth() + 1, +year || now.getFullYear(), hospitalId, departmentId);
  }

  @Get('preview/:employeeId')
    @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.ASSISTANT_ADMIN)
  preview(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const now = new Date();
    return this.service.calculate(employeeId, +month || now.getMonth() + 1, +year || now.getFullYear());
  }

  @Get(':employeeId')
    @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.ASSISTANT_ADMIN)
  findOne(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const now = new Date();
    return this.service.findOne(employeeId, +month || now.getMonth() + 1, +year || now.getFullYear());
  }

  @Post('generate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.ASSISTANT_ADMIN)
  generate(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Body() body: { month: number; year: number; departmentId?: string },
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.generateMonthlyPayroll(body.month, body.year, hospitalId, body.departmentId);
  }

  @Post('save/:employeeId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  save(
    @Param('employeeId') employeeId: string,
    @Body() body: {
      month: number; year: number;
      manualBonus?: number; manualDeduction?: number; note?: string;
    },
  ) {
    return this.service.createOrUpdate(
      employeeId, body.month, body.year,
      body.manualBonus, body.manualDeduction, body.note,
    );
  }

  @Put('approve/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  approve(@Param('id') id: string) {
    return this.service.approve(id);
  }

  // ── EMPLOYEE: o'z maosh tarixini ko'rish ──────────────────────
  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  findMyPayroll(
    @CurrentUser('sub') userId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.service.findMyRecords(userId, month ? +month : undefined, year ? +year : undefined);
  }

  // ── EMPLOYEE: o'z maosh varaqasini PDF yuklab olish ────────────
  @Get('my/payslip')
  @Roles(UserRole.EMPLOYEE)
  async downloadMyPayslip(
    @CurrentUser('sub') userId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const now = new Date();
    const m = +month || now.getMonth() + 1;
    const y = +year || now.getFullYear();
    const buffer = await this.service.generateMyPayslipPdf(userId, m, y);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="maosh_varaqasi_${m}_${y}.pdf"`,
    });
    return new StreamableFile(buffer);
  }

  @Get('payslip/:employeeId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.ASSISTANT_ADMIN, UserRole.EMPLOYEE)
  async downloadPayslip(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const now = new Date();
    const m = +month || now.getMonth() + 1;
    const y = +year || now.getFullYear();
    const buffer = await this.service.generatePayslipPdf(employeeId, m, y);
    const MONTHS = ['', 'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
                    'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
    const filename = `maosh-${m}-${y}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Get('export/excel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR, UserRole.ASSISTANT_ADMIN)
  async exportExcel(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('targetHospitalId') targetHospitalId: string,
    @Query('departmentId') departmentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const now = new Date();
    const m = +month || now.getMonth() + 1;
    const y = +year || now.getFullYear();
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    const buffer = await this.service.exportExcel(m, y, hospitalId, departmentId);
    const filename = `maosh_${m}_${y}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }
}
