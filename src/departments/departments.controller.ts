import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';

function resolveHospitalId(
  jwtHospId: string | null,
  targetHospId?: string,
): string | null {
  return jwtHospId || targetHospId || null;
}

@Controller('departments')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class DepartmentsController {
  constructor(private readonly service: DepartmentsService) {}

  @Get()
  findAll(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findAll(
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findOne(
      id,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Post()
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
  )
  create(
    @Body() body: CreateDepartmentDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.create(
      body,
      resolveHospitalId(hospitalId, targetHospitalId)!,
    );
  }

  @Put(':id')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
  )
  update(
    @Param('id') id: string,
    @Body() body: UpdateDepartmentDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.update(
      id,
      body,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Delete(':id')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
  )
  remove(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.remove(
      id,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }
}
