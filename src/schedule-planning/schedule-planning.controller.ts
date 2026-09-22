import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SchedulePlanningService } from './schedule-planning.service';
import { CreateSchedulePostDto } from './dto/create-schedule-post.dto';
import { CreateMonthlySchedulePlanDto } from './dto/create-monthly-schedule-plan.dto';
import { SaveSchedulePlanEntriesDto } from './dto/save-schedule-plan-entries.dto';
import { CreateScheduleChangeDto } from './dto/create-schedule-change.dto';

const READ_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
  UserRole.DEPARTMENT_HEAD,
];

const WRITE_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
];

const CHANGE_REQUEST_ROLES = [...READ_ROLES, UserRole.EMPLOYEE];

@Controller('schedule-planning')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class SchedulePlanningController {
  constructor(private readonly service: SchedulePlanningService) {}

  @Get('config')
  @Roles(...READ_ROLES)
  getConfig(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.getConfig(
      this.resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Get('posts')
  @Roles(...READ_ROLES)
  listPosts(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.service.listPosts(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      departmentId,
    );
  }

  @Post('posts')
  @Roles(...WRITE_ROLES)
  createPost(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: CreateSchedulePostDto,
  ) {
    return this.service.createPost(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      dto,
    );
  }

  @Get('plans')
  @Roles(...READ_ROLES)
  listPlans(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('postId') postId?: string,
  ) {
    return this.service.listPlans(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      {
        ...(year && { year: Number(year) }),
        ...(month && { month: Number(month) }),
        ...(postId && { postId }),
      },
    );
  }

  @Post('plans')
  @Roles(...WRITE_ROLES)
  createDraftPlan(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: CreateMonthlySchedulePlanDto,
  ) {
    return this.service.createDraftPlan(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      userId,
      dto,
    );
  }

  @Get('plans/:id')
  @Roles(...READ_ROLES)
  getPlan(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.getPlanDetails(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
    );
  }

  @Put('plans/:id/entries')
  @Roles(...WRITE_ROLES)
  saveEntries(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: SaveSchedulePlanEntriesDto,
  ) {
    return this.service.saveEntries(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
      dto,
    );
  }

  @Get('plans/:id/export')
  @Roles(...READ_ROLES)
  async exportPlan(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buffer = await this.service.exportPlanExcel(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="post-grafik-${id}.xlsx"`,
    );
    response.setHeader('Content-Length', buffer.length.toString());
    return new StreamableFile(buffer);
  }

  @Post('plans/:id/submit')
  @Roles(...WRITE_ROLES)
  submitPlan(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.submitPlan(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
    );
  }

  @Post('plans/:id/approve')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  approvePlan(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.approvePlan(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
      userId,
    );
  }

  @Post('plans/:id/reject')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  rejectPlan(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body('reason') reason: string,
  ) {
    if (!reason?.trim())
      throw new BadRequestException('Rad etish sababini kiriting');
    return this.service.rejectPlan(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
      userId,
      reason,
    );
  }

  @Post('changes')
  @Roles(...CHANGE_REQUEST_ROLES)
  createChangeRequest(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRole,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: CreateScheduleChangeDto,
  ) {
    return this.service.createChangeRequest(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      userId,
      role,
      dto,
    );
  }

  @Patch('changes/:id/accept')
  @Roles(...CHANGE_REQUEST_ROLES)
  acceptChangeRequest(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.acceptChangeRequest(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
      userId,
    );
  }

  @Patch('changes/:id/approve')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  approveChangeRequest(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.approveChangeRequest(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
      userId,
    );
  }

  @Patch('changes/:id/reject')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  rejectChangeRequest(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('sub') userId: string,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body('reason') reason: string,
  ) {
    if (!reason?.trim())
      throw new BadRequestException('Rad etish sababini kiriting');
    return this.service.rejectChangeRequest(
      this.resolveHospitalId(hospitalId, targetHospitalId),
      id,
      userId,
      reason,
    );
  }

  private resolveHospitalId(
    hospitalId: string | null,
    targetHospitalId?: string,
  ): string {
    const resolved = hospitalId || targetHospitalId;
    if (!resolved) {
      throw new BadRequestException('Avval muassasani tanlang');
    }
    return resolved;
  }
}
