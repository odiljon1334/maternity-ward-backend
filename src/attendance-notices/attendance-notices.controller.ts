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
import { AttendanceNoticesService } from './attendance-notices.service';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { ReviewNoticeDto } from './dto/review-notice.dto';

@Controller('attendance-notices')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class AttendanceNoticesController {
  constructor(private readonly svc: AttendanceNoticesService) {}

  // ─── Xodim ───────────────────────────────────────────────────────────────

  /** "Kechikaman" xabarini yuborish (bugungi kun uchun) */
  @Post()
  @Roles(UserRole.EMPLOYEE)
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateNoticeDto) {
    return this.svc.create(userId, dto);
  }

  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  my(@CurrentUser('sub') userId: string) {
    return this.svc.my(userId);
  }

  @Patch(':id/cancel')
  @Roles(UserRole.EMPLOYEE)
  cancel(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.cancel(userId, id);
  }

  // ─── Rahbar ──────────────────────────────────────────────────────────────

  @Get()
  @Roles(
    UserRole.DIRECTOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.DEPARTMENT_HEAD,
  )
  list(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetId?: string,
    @Query('status') status?: string,
    @Query('days') days?: string,
  ) {
    return this.svc.list(scopeHospitalId(jwtHospitalId, targetId), {
      status,
      days: days ? Math.min(90, Math.max(1, +days || 14)) : undefined,
    });
  }

  @Patch(':id/review')
  @Roles(
    UserRole.DIRECTOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
  )
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') reviewerId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Body() dto: ReviewNoticeDto,
    @Query('targetHospitalId') targetId?: string,
  ) {
    return this.svc.review(
      id,
      dto.decision,
      {
        userId: reviewerId,
        hospitalId: scopeHospitalId(jwtHospitalId, targetId),
      },
      dto.note,
    );
  }
}
