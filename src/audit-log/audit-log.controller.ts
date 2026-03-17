import { Controller, Delete, Get, Query, UseGuards } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.DIRECTOR, UserRole.ADMIN)
  findAll(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('entity') entity?: string,
    @Query('action') action?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.auditLogService.findAll({
      hospitalId,
      entity,
      action,
      page: +page,
      limit: +limit,
    });
  }

  /** Eski loglarni tozalash — faqat SUPER_ADMIN */
  @Delete('clear')
  @Roles(UserRole.SUPER_ADMIN)
  clearOldLogs(
    @CurrentUser('sub') userId: string,
    @Query('olderThanDays') olderThanDays = '90',
  ) {
    return this.auditLogService.clearOldLogs(+olderThanDays, userId);
  }
}
