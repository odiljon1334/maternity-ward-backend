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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { CompensationService } from './compensation.service';
import {
  AdjustmentDecisionDto,
  AdvanceDecisionDto,
  CreateAdjustmentDto,
  EmployeeExplanationDto,
  MarkAdvancePaidDto,
  RequestAdvanceDto,
} from './dto/compensation.dto';

const MANAGER_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
  UserRole.ASSISTANT_ADMIN,
] as const;

@Controller('compensation')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class CompensationController {
  constructor(private readonly service: CompensationService) {}

  @Get('my/adjustments')
  @Roles(UserRole.EMPLOYEE)
  myAdjustments(
    @CurrentUser('sub') userId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.service.myAdjustments(
      userId,
      month ? +month : undefined,
      year ? +year : undefined,
    );
  }

  @Patch('my/adjustments/:id/explanation')
  @Roles(UserRole.EMPLOYEE)
  submitExplanation(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: EmployeeExplanationDto,
  ) {
    return this.service.submitExplanation(id, userId, dto.explanation);
  }

  @Patch('my/adjustments/:id/acknowledge')
  @Roles(UserRole.EMPLOYEE)
  acknowledgeAdjustment(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.service.acknowledgeAdjustment(id, userId);
  }

  @Get('my/advances')
  @Roles(UserRole.EMPLOYEE)
  myAdvances(
    @CurrentUser('sub') userId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.service.myAdvances(
      userId,
      month ? +month : undefined,
      year ? +year : undefined,
    );
  }

  @Post('my/advances')
  @Roles(UserRole.EMPLOYEE)
  requestMyAdvance(
    @CurrentUser('sub') userId: string,
    @Body() dto: RequestAdvanceDto,
  ) {
    return this.service.requestAdvance(userId, true, undefined, dto);
  }

  @Get('adjustments')
  @Roles(...MANAGER_ROLES)
  listAdjustments(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('employeeId') employeeId?: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.service.listAdjustments({
      hospitalId: jwtHospitalId || targetHospitalId || undefined,
      employeeId,
      month: month ? +month : undefined,
      year: year ? +year : undefined,
    });
  }

  @Post('adjustments')
  @Roles(...MANAGER_ROLES)
  createAdjustment(
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.service.createAdjustment(
      actorId,
      jwtHospitalId || targetHospitalId || undefined,
      dto,
    );
  }

  @Patch('adjustments/:id/decision')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  decideAdjustment(
    @Param('id') id: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: AdjustmentDecisionDto,
  ) {
    return this.service.decideAdjustment(
      id,
      actorId,
      jwtHospitalId || targetHospitalId || undefined,
      dto,
    );
  }

  @Get('advances')
  @Roles(...MANAGER_ROLES)
  listAdvances(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Query('employeeId') employeeId?: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.service.listAdvances({
      hospitalId: jwtHospitalId || targetHospitalId || undefined,
      employeeId,
      month: month ? +month : undefined,
      year: year ? +year : undefined,
    });
  }

  @Post('advances')
  @Roles(...MANAGER_ROLES)
  createAdvance(
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: RequestAdvanceDto,
  ) {
    return this.service.requestAdvance(
      actorId,
      false,
      jwtHospitalId || targetHospitalId || undefined,
      dto,
    );
  }

  @Patch('advances/:id/decision')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  decideAdvance(
    @Param('id') id: string,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: AdvanceDecisionDto,
  ) {
    return this.service.decideAdvance(
      id,
      actorId,
      jwtHospitalId || targetHospitalId || undefined,
      dto,
    );
  }

  @Patch('advances/:id/paid')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  markAdvancePaid(
    @Param('id') id: string,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId: string | undefined,
    @Body() dto: MarkAdvancePaidDto,
  ) {
    return this.service.markAdvancePaid(
      id,
      jwtHospitalId || targetHospitalId || undefined,
      dto,
    );
  }
}
