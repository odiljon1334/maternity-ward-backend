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
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { scopeHospitalId } from '../leave/leave.controller';
import { ShiftSwapsService } from './shift-swaps.service';
import { CreateSwapDto } from './dto/create-swap.dto';

class RespondSwapDto {
  @IsBoolean()
  accept: boolean;
}

class ReviewSwapDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

@Controller('shift-swaps')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class ShiftSwapsController {
  constructor(private readonly svc: ShiftSwapsService) {}

  // ─── Xodim ───────────────────────────────────────────────────────────────

  @Get('my-days')
  @Roles(UserRole.EMPLOYEE)
  myDays(@CurrentUser('sub') userId: string) {
    return this.svc.myUpcoming(userId);
  }

  @Get('candidates')
  @Roles(UserRole.EMPLOYEE)
  candidates(@CurrentUser('sub') userId: string, @Query('date') date: string) {
    return this.svc.candidates(userId, date);
  }

  @Get('my')
  @Roles(UserRole.EMPLOYEE)
  my(@CurrentUser('sub') userId: string) {
    return this.svc.my(userId);
  }

  @Post()
  @Roles(UserRole.EMPLOYEE)
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateSwapDto) {
    return this.svc.create(userId, dto);
  }

  @Patch(':id/respond')
  @Roles(UserRole.EMPLOYEE)
  respond(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondSwapDto,
  ) {
    return this.svc.respond(userId, id, dto.accept);
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
  ) {
    return this.svc.list(scopeHospitalId(jwtHospitalId, targetId), status);
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
    @Body() dto: ReviewSwapDto,
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
