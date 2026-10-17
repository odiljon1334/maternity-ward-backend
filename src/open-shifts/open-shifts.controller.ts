import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { scopeHospitalId } from '../leave/leave.controller';
import { OpenShiftsService } from './open-shifts.service';
import {
  CreateOpenShiftDto,
  PreviewOpenShiftDto,
  ReviewOpenShiftDto,
} from './dto/open-shift.dto';

/** Bo'sh smenani e'lon qiladigan va tasdiqlaydigan rollar (smena almashish bilan bir xil). */
const MANAGERS = [
  UserRole.DIRECTOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
];

@Controller('open-shifts')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class OpenShiftsController {
  constructor(private readonly svc: OpenShiftsService) {}

  // ─── Xodim ───────────────────────────────────────────────────────────────

  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  my(@CurrentUser('sub') userId: string) {
    return this.svc.myOffers(userId);
  }

  @Post(':id/claim')
  @Roles(UserRole.EMPLOYEE)
  claim(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.claimByUser(userId, id);
  }

  @Post(':id/decline')
  @Roles(UserRole.EMPLOYEE)
  decline(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.declineByUser(userId, id);
  }

  // ─── Rahbar ──────────────────────────────────────────────────────────────

  @Get()
  @Roles(...MANAGERS)
  list(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetId?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.list(scopeHospitalId(jwtHospitalId, targetId), status);
  }

  @Post('preview')
  @Roles(...MANAGERS)
  preview(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Body() dto: PreviewOpenShiftDto,
    @Query('targetHospitalId') targetId?: string,
  ) {
    return this.svc.preview(scopeHospitalId(jwtHospitalId, targetId), dto);
  }

  @Post()
  @Roles(...MANAGERS)
  create(
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Body() dto: CreateOpenShiftDto,
    @Query('targetHospitalId') targetId?: string,
  ) {
    return this.svc.create(
      scopeHospitalId(jwtHospitalId, targetId),
      userId,
      dto,
    );
  }

  @Patch(':id/review')
  @Roles(...MANAGERS)
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Body() dto: ReviewOpenShiftDto,
    @Query('targetHospitalId') targetId?: string,
  ) {
    return this.svc.review(
      id,
      dto.decision,
      { userId, hospitalId: scopeHospitalId(jwtHospitalId, targetId) },
      dto.note,
    );
  }

  @Patch(':id/cancel')
  @Roles(...MANAGERS)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetId?: string,
  ) {
    return this.svc.cancel(id, scopeHospitalId(jwtHospitalId, targetId));
  }
}
