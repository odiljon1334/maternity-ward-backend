import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { LeaveService } from './leave.service';
import { CreateLeaveDto, ReviewLeaveDto } from './dto/leave.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

/**
 * Muassasa ID'sini aniqlash.
 *
 * XAVFSIZLIK (2026-09-23 audit): JWT'dagi hospitalId HAR DOIM ustun.
 * Ilgari `targetId || jwt` tartibi tufayli A muassasa direktori
 * `?targetHospitalId=B` bilan B'ning ta'tillarini ko'rib, tasdiqlab va
 * grafigini o'zgartira olardi. `targetHospitalId` faqat JWT'da muassasa
 * bo'lmagan platforma rollari (SUPER_ADMIN) uchun ishlatiladi;
 * ASSISTANT_ADMIN uchun TenantScopeGuard JWT qiymatini tasdiqlangan
 * muassasaga almashtirib qo'yadi.
 */
export function scopeHospitalId(
  jwtHospitalId: string | null | undefined,
  targetHospitalId?: string,
): string {
  return jwtHospitalId || targetHospitalId || '';
}

@Controller('leave')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class LeaveController {
  constructor(private readonly svc: LeaveService) {}

  // ─── EMPLOYEE ────────────────────────────────────────────────────────────────

  /** Yangi ta'til so'rovi yaratish */
  @Post()
  @Roles(UserRole.EMPLOYEE)
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateLeaveDto) {
    return this.svc.create(userId, dto);
  }

  /** O'z ta'til so'rovlarini ko'rish */
  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  getMyLeaves(
    @CurrentUser('sub') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.getMyLeaves(userId, {
      status,
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
    });
  }

  /** PENDING so'rovni bekor qilish (faqat PENDING) */
  @Patch(':id/cancel')
  @Roles(UserRole.EMPLOYEE)
  cancel(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    return this.svc.cancel(id, userId);
  }

  // ─── DIRECTOR / ADMIN ────────────────────────────────────────────────────────

  /** Kasalxona so'rovlarini ko'rish */
  @Get()
  @Roles(
    UserRole.DIRECTOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.DEPARTMENT_HEAD,
  )
  getAll(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const hospitalId = scopeHospitalId(jwtHospitalId, targetId);
    return this.svc.getAll(hospitalId, {
      status,
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
    });
  }

  /** Tasdiqlash yoki rad etish */
  @Patch(':id/review')
  @Roles(
    UserRole.DIRECTOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
  )
  review(
    @Param('id') id: string,
    @CurrentUser('sub') reviewerId: string,
    @CurrentUser('hospitalId') jwtHospId: string | null,
    @Body() dto: ReviewLeaveDto,
    @Query('targetHospitalId') targetId?: string,
  ) {
    const hospitalId = scopeHospitalId(jwtHospId, targetId);
    return this.svc.review(id, reviewerId, dto, hospitalId);
  }

  /** Tasdiqlangan ta'tilni qaytarish */
  @Patch(':id/revoke')
  @Roles(
    UserRole.DIRECTOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
  )
  revoke(
    @Param('id') id: string,
    @CurrentUser('hospitalId') jwtHospId: string | null,
    @Query('targetHospitalId') targetId?: string,
  ) {
    const hospitalId = scopeHospitalId(jwtHospId, targetId);
    return this.svc.revokeApproval(id, hospitalId);
  }
}
