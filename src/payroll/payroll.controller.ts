import {
  Body, Controller, Get, Param, Post, Put, Query,
  UseGuards, Res, StreamableFile,
} from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { Response } from 'express';

@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  findAll(@Query('month') month: string, @Query('year') year: string) {
    const now = new Date();
    return this.service.findAll(+month || now.getMonth() + 1, +year || now.getFullYear());
  }

  @Get('preview/:employeeId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  preview(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const now = new Date();
    return this.service.calculate(employeeId, +month || now.getMonth() + 1, +year || now.getFullYear());
  }

  @Get(':employeeId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  findOne(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const now = new Date();
    return this.service.findOne(employeeId, +month || now.getMonth() + 1, +year || now.getFullYear());
  }

  @Post('generate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  generate(@Body() body: { month: number; year: number }) {
    return this.service.generateMonthlyPayroll(body.month, body.year);
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

  @Get('export/excel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async exportExcel(
    @Query('month') month: string,
    @Query('year') year: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const now = new Date();
    const m = +month || now.getMonth() + 1;
    const y = +year || now.getFullYear();
    const buffer = await this.service.exportExcel(m, y);
    const filename = `maosh_${m}_${y}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }
}
