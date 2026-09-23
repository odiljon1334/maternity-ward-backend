import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WorkSitesService } from './work-sites.service';
import {
  ApproveLegacyCenterDto,
  CreateWorkSiteDto,
  SetWorkSiteEmployeesDto,
  UpdateWorkSiteDto,
} from './dto/work-site.dto';

const MANAGERS = [
  UserRole.DIRECTOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
];

/**
 * Muassasa ID'si: JWT HAR DOIM ustun (DIRECTOR/ADMIN; ASSISTANT_ADMIN uchun
 * TenantScopeGuard JWT qiymatini tasdiqlangan muassasaga almashtiradi).
 * `targetHospitalId` faqat JWT'da muassasa yo'q SUPER_ADMIN uchun.
 */
export function resolveWorkSiteHospital(
  jwtHospitalId: string | null | undefined,
  targetHospitalId?: string,
): string {
  const id = jwtHospitalId || targetHospitalId;
  if (!id)
    throw new BadRequestException('Muassasani tanlang (targetHospitalId)');
  return id;
}

@Controller('work-sites')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class WorkSitesController {
  constructor(private readonly svc: WorkSitesService) {}

  /** Xodim uchun: check-in qila oladigan joylari */
  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  my(@CurrentUser('sub') userId: string) {
    return this.svc.myCenters(userId);
  }

  @Get()
  @Roles(...MANAGERS)
  list(
    @CurrentUser('hospitalId') jwt: string | null,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.list(resolveWorkSiteHospital(jwt, target));
  }

  @Post()
  @Roles(...MANAGERS)
  create(
    @CurrentUser('hospitalId') jwt: string | null,
    @Body() dto: CreateWorkSiteDto,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.create(resolveWorkSiteHospital(jwt, target), dto);
  }

  @Get('legacy-centers')
  @Roles(...MANAGERS)
  legacyCenters(
    @CurrentUser('hospitalId') jwt: string | null,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.listLegacyCenters(resolveWorkSiteHospital(jwt, target));
  }

  @Post('legacy-centers/:employeeId/approve')
  @Roles(...MANAGERS)
  approveLegacy(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: ApproveLegacyCenterDto,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.approveLegacyCenter(
      resolveWorkSiteHospital(jwt, target),
      employeeId,
      dto,
    );
  }

  @Post('legacy-centers/:employeeId/reject')
  @Roles(...MANAGERS)
  rejectLegacy(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.rejectLegacyCenter(
      resolveWorkSiteHospital(jwt, target),
      employeeId,
    );
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  update(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkSiteDto,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.update(resolveWorkSiteHospital(jwt, target), id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  remove(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.remove(resolveWorkSiteHospital(jwt, target), id);
  }

  @Get(':id/employees')
  @Roles(...MANAGERS)
  employees(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.listEmployees(resolveWorkSiteHospital(jwt, target), id);
  }

  @Put(':id/employees')
  @Roles(...MANAGERS)
  setEmployees(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetWorkSiteEmployeesDto,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.setEmployees(
      resolveWorkSiteHospital(jwt, target),
      id,
      dto.employeeIds,
    );
  }
}
