import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { LeaveService }    from './leave.service';
import { CreateLeaveDto, ReviewLeaveDto } from './dto/leave.dto';
import { JwtAuthGuard }    from '../common/guards/jwt-auth.guard';
import { RolesGuard }      from '../common/guards/roles.guard';
import { Roles }           from '../common/decorators/roles.decorator';
import { CurrentUser }     from '../common/decorators/current-user.decorator';

@Controller('leave')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveController {
  constructor(private readonly svc: LeaveService) {}

  // ─── EMPLOYEE ────────────────────────────────────────────────────────────────

  /** Yangi ta'til so'rovi yaratish */
  @Post()
  @Roles(UserRole.EMPLOYEE)
  create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateLeaveDto,
  ) {
    return this.svc.create(userId, dto);
  }

  /** O'z ta'til so'rovlarini ko'rish */
  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  getMyLeaves(
    @CurrentUser('sub') userId: string,
    @Query('status') status?: string,
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
  ) {
    return this.svc.getMyLeaves(userId, {
      status,
      page:  page  ? +page  : undefined,
      limit: limit ? +limit : undefined,
    });
  }

  /** PENDING so'rovni bekor qilish (faqat PENDING) */
  @Patch(':id/cancel')
  @Roles(UserRole.EMPLOYEE)
  cancel(
    @Param('id')       id:     string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.svc.cancel(id, userId);
  }

  // ─── DIRECTOR / ADMIN ────────────────────────────────────────────────────────

  /** Kasalxona so'rovlarini ko'rish */
  @Get()
  @Roles(UserRole.DIRECTOR, UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN, UserRole.DEPARTMENT_HEAD)
  getAll(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId')  targetId?:    string,
    @Query('status')            status?:      string,
    @Query('page')              page?:        string,
    @Query('limit')             limit?:       string,
  ) {
    const hospitalId = targetId || jwtHospitalId || '';
    return this.svc.getAll(hospitalId, {
      status,
      page:  page  ? +page  : undefined,
      limit: limit ? +limit : undefined,
    });
  }

  /** Tasdiqlash yoki rad etish */
  @Patch(':id/review')
  @Roles(UserRole.DIRECTOR, UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  review(
    @Param('id')                id:         string,
    @CurrentUser('sub')         reviewerId: string,
    @CurrentUser('hospitalId')  jwtHospId:  string | null,
    @Body() dto: ReviewLeaveDto,
    @Query('targetHospitalId')  targetId?:  string,
  ) {
    const hospitalId = targetId || jwtHospId || '';
    return this.svc.review(id, reviewerId, dto, hospitalId);
  }

  /** Tasdiqlangan ta'tilni qaytarish */
  @Patch(':id/revoke')
  @Roles(UserRole.DIRECTOR, UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  revoke(
    @Param('id')               id:        string,
    @CurrentUser('hospitalId') jwtHospId: string | null,
    @Query('targetHospitalId') targetId?: string,
  ) {
    const hospitalId = targetId || jwtHospId || '';
    return this.svc.revokeApproval(id, hospitalId);
  }
}
