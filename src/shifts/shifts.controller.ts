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
import { ShiftsService } from './shifts.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

function resolveHospitalId(
  jwtHospId: string | null,
  targetHospId?: string,
): string | null {
  return jwtHospId || targetHospId || null;
}

@Controller('shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

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
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  create(
    @Body() dto: CreateShiftDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.create(
      dto,
      resolveHospitalId(hospitalId, targetHospitalId)!,
    );
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateShiftDto>,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.update(
      id,
      dto,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
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

  /** Default DAYTIME + NIGHTTIME smenlarini avtomatik yaratish */
  @Post('seed')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  seed(
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.seed(resolveHospitalId(hospitalId, targetHospitalId)!);
  }
}
