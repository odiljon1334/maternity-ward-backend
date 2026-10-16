import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { resolveHospitalId } from '../common/utils/hospital-scope.util';
import { OperationalCenterService } from './operational-center.service';

const READ_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
  UserRole.DEPARTMENT_HEAD,
];

@Controller('operational-center')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class OperationalCenterController {
  constructor(private readonly service: OperationalCenterService) {}

  @Get('overview')
  @Roles(...READ_ROLES)
  getOverview(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = resolveHospitalId(jwtHospitalId, targetHospitalId);
    if (!hospitalId) {
      throw new BadRequestException('Avval muassasani tanlang');
    }
    return this.service.getOverview(hospitalId);
  }
}
