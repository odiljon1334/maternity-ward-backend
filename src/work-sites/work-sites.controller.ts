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
import { PlaceSearchService } from './place-search.service';
import {
  ApproveLegacyCenterDto,
  CreateWorkSiteDto,
  SetEmployeeWorkSitesDto,
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
  constructor(
    private readonly svc: WorkSitesService,
    private readonly places: PlaceSearchService,
  ) {}

  /**
   * Ish joyi manzilini nomi bo'yicha qidirish ("1-maktab Andijon"), yoki
   * koordinata / Yandex·Google xarita havolasini qo'yish. Natijalar muassasa
   * markaziga yaqinlari bo'yicha tartiblanadi.
   */
  @Get('place-search')
  @Roles(...MANAGERS)
  placeSearch(
    @Query('q') q: string,
    @CurrentUser('hospitalId') jwt: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') target?: string,
  ) {
    // ?q=a&q=b massiv bo'lib kelishi mumkin; xarita havolasi uzun bo'ladi
    return this.places.search(
      String(Array.isArray(q) ? q[0] : (q ?? '')).slice(0, 2000),
      resolveWorkSiteHospital(jwt, target),
      userId,
    );
  }

  /** Qidiruv natijasi tanlanganda uning koordinatasi (Yandex `uri` bo'yicha) */
  @Get('place-resolve')
  @Roles(...MANAGERS)
  placeResolve(
    @Query('uri') uri: string,
    @CurrentUser('hospitalId') jwt: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.places.resolve(
      String(Array.isArray(uri) ? uri[0] : (uri ?? '')),
      resolveWorkSiteHospital(jwt, target),
      userId,
    );
  }

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

  /** Xodim sahifasi: uning GPS markazlari (barcha ish joylari + belgi) */
  @Get('employee/:employeeId')
  @Roles(...MANAGERS)
  employeeSites(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.employeeSites(
      resolveWorkSiteHospital(jwt, target),
      employeeId,
    );
  }

  @Put('employee/:employeeId')
  @Roles(...MANAGERS)
  setEmployeeSites(
    @CurrentUser('hospitalId') jwt: string | null,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: SetEmployeeWorkSitesDto,
    @Query('targetHospitalId') target?: string,
  ) {
    return this.svc.setEmployeeSites(
      resolveWorkSiteHospital(jwt, target),
      employeeId,
      dto.workSiteIds,
    );
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
