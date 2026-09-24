import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { Response } from 'express';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  // ── STATIK VA MAXSUS ROUTELAR (DOIM TEPADA BO'LISHI KERAK) ──

  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  findMyPayroll(
    @CurrentUser('sub') userId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.service.findMyRecords(
      userId,
      month ? +month : undefined,
      year ? +year : undefined,
    );
  }

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

  @Get()
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
    UserRole.ASSISTANT_ADMIN,
  )
  @RequirePermission('payroll.view')
  findAll(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    const now = new Date();
    const hospitalId = jwtHospitalId || targetHospitalId || undefined;
    return this.service.findAll(
      +month || now.getMonth() + 1,
      +year || now.getFullYear(),
      hospitalId,
      departmentId,
    );
  }

  @Post('generate')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
    UserRole.ASSISTANT_ADMIN,
  )
  generate(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Body() body: { month: number; year: number; departmentId?: string },
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = jwtHospitalId || targetHospitalId || undefined;
    return this.service.generateMonthlyPayroll(
      body.month,
      body.year,
      hospitalId,
      body.departmentId,
    );
  }

  @Get('export/excel')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
    UserRole.ASSISTANT_ADMIN,
  )
  @RequirePermission('payroll.view')
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
    const hospitalId = jwtHospitalId || targetHospitalId || undefined;
    const buffer = await this.service.exportExcel(
      m,
      y,
      hospitalId,
      departmentId,
    );
    const filename = `maosh_${m}_${y}.xlsx`;
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Post('save/:employeeId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  save(
    @Param('employeeId') employeeId: string,
    @Body()
    body: {
      month: number;
      year: number;
      manualBonus?: number;
      manualDeduction?: number;
      note?: string;
    },
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    // XAVFSIZLIK (3-paket): ADMIN faqat o'z muassasasi xodimining maoshini
    // saqlaydi (ilgari istalgan xodim ID'si qabul qilinardi)
    return this.service.createOrUpdate(
      employeeId,
      body.month,
      body.year,
      body.manualBonus,
      body.manualDeduction,
      body.note,
      hospitalId,
    );
  }

  @Put('approve/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  @RequirePermission('payroll.approve')
  approve(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    return this.service.approve(id, hospitalId);
  }

  // ── DINAMIK PARAMETRLI ROUTELAR (DOIM PASTDA BO'LISHI KERAK) ──

  @Get('preview/:employeeId')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
    UserRole.ASSISTANT_ADMIN,
  )
  @RequirePermission('payroll.view')
  async preview(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    const now = new Date();
    const { preview, details } = await this.service.calculate(
      employeeId,
      +month || now.getMonth() + 1,
      +year || now.getFullYear(),
      hospitalId,
    );
    return { preview, details };
  }

  @Get('payslip/:employeeId')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
    UserRole.ASSISTANT_ADMIN,
  )
  async downloadPayslip(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ): Promise<StreamableFile> {
    const now = new Date();
    const m = +month || now.getMonth() + 1;
    const y = +year || now.getFullYear();
    const buffer = await this.service.generatePayslipPdf(
      employeeId,
      m,
      y,
      hospitalId,
    );
    const filename = `maosh-${m}-${y}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Get(':employeeId')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
    UserRole.ASSISTANT_ADMIN,
  )
  @RequirePermission('payroll.view')
  findOne(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    const now = new Date();
    return this.service.findOne(
      employeeId,
      +month || now.getMonth() + 1,
      +year || now.getFullYear(),
      hospitalId,
    );
  }
}
