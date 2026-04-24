import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SchedulesService } from './schedules.service';
import {
  GenerateScheduleDto,
  BulkGenerateScheduleDto,
  BulkManualScheduleDto,
} from './dto/generate-schedule.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole, ScheduleStatus } from '@prisma/client';

function resolveHospitalId(jwtHospId: string | null, targetHospId?: string): string | null {
  return jwtHospId || targetHospId || null;
}

@SkipThrottle()
@Controller('schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SchedulesController {
  constructor(private readonly service: SchedulesService) {}

  @Get('employee/:id')
  getEmployeeSchedule(
    @Param('id') id: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.service.getEmployeeSchedule(id, +month, +year);
  }

  @Get('daily')
  getDailySchedule(
    @Query('date') date: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.getDailySchedule(
      date || new Date().toISOString().slice(0, 10),
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Get('monthly')
  getMonthlySchedules(
    @Query('month') month: string,
    @Query('year') year: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.getMonthlySchedules(
      +month || new Date().getMonth() + 1,
      +year  || new Date().getFullYear(),
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Post('generate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  generate(@Body() dto: GenerateScheduleDto) {
    return this.service.generate(dto);
  }

  @Post('bulk-generate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  bulkGenerate(
    @Body() dto: BulkGenerateScheduleDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    // Bo'lim bo'yicha filter — hospitalId bilan birgalikda
    const resolvedHospId = resolveHospitalId(hospitalId, targetHospitalId);
    return this.service.bulkGenerate({ ...dto, hospitalId: resolvedHospId } as any);
  }

  @Post('manual')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  bulkManual(@Body() dto: BulkManualScheduleDto) {
    return this.service.bulkManual(dto);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  updateEntry(
    @Param('id') id: string,
    @Body() body: { shiftId?: string; status?: ScheduleStatus; note?: string },
  ) {
    return this.service.updateEntry(id, body);
  }
}
