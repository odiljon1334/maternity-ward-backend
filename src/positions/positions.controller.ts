import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PositionsService } from './positions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

function resolveHospitalId(jwtHospId: string | null, targetHospId?: string): string | null {
  return jwtHospId || targetHospId || null;
}

@SkipThrottle()
@Controller('positions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PositionsController {
  constructor(private readonly service: PositionsService) {}

  @Get()
  findAll(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findAll(resolveHospitalId(hospitalId, targetHospitalId));
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findOne(id, resolveHospitalId(hospitalId, targetHospitalId));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  create(
    @Body() body: { name: string },
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.create(body, resolveHospitalId(hospitalId, targetHospitalId)!);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  update(
    @Param('id') id: string,
    @Body() body: { name: string },
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.update(id, body, resolveHospitalId(hospitalId, targetHospitalId));
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  remove(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.remove(id, resolveHospitalId(hospitalId, targetHospitalId));
  }
}
