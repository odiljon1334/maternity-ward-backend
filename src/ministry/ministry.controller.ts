import {
  Controller, Get, Param, Query,
  UseGuards, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { MinistryService } from './ministry.service';
import { JwtAuthGuard }  from '../common/guards/jwt-auth.guard';
import { RolesGuard }    from '../common/guards/roles.guard';
import { Roles }         from '../common/decorators/roles.decorator';

/** Faqat SUPER_ADMIN va MINISTRY roli kirishi mumkin */
const MINISTRY_ROLES = [UserRole.SUPER_ADMIN, UserRole.MINISTRY];

@Controller('ministry')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MINISTRY_ROLES)
export class MinistryController {
  constructor(private readonly service: MinistryService) {}

  /**
   * GET /ministry/overview
   * Barcha kasalxonalar umumiy ko'rinishi.
   * ?date=2026-04-11  — boshqa sana uchun
   */
  @Get('overview')
  getOverview(@Query('date') date?: string) {
    return this.service.getOverview(date);
  }

  /**
   * GET /ministry/hospitals/:id/detail
   * Bitta kasalxona to'liq statistikasi.
   * ?date=2026-04-11
   */
  @Get('hospitals/:id/detail')
  getHospitalDetail(
    @Param('id') id: string,
    @Query('date') date?: string,
  ) {
    return this.service.getHospitalDetail(id, date);
  }

  /**
   * GET /ministry/attendance/absent
   * Bugun kelmagan xodimlar ro'yxati.
   * ?hospitalId=xxx   — bitta kasalxona uchun filtr
   * ?date=2026-04-11
   */
  @Get('attendance/absent')
  getAbsentToday(
    @Query('hospitalId') hospitalId?: string,
    @Query('date')       date?: string,
  ) {
    return this.service.getAbsentToday(hospitalId, date);
  }

  /**
   * GET /ministry/payroll/summary
   * Barcha kasalxonalar oylik maosh xulosasi.
   * ?month=4&year=2026
   */
  @Get('payroll/summary')
  getPayrollSummary(
    @Query('month', new DefaultValuePipe(new Date().getMonth() + 1), ParseIntPipe) month: number,
    @Query('year',  new DefaultValuePipe(new Date().getFullYear()),   ParseIntPipe) year:  number,
  ) {
    return this.service.getPayrollSummary(month, year);
  }
}
