import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UserRole } from '@prisma/client';
import { QueryUsersDto } from './dto/query-users.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { SetPermissionOverrideDto } from './dto/set-permission-override.dto';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

const SUPER = UserRole.SUPER_ADMIN;
const ASST = UserRole.ASSISTANT_ADMIN;
const ADMIN = UserRole.ADMIN;
const DIR = UserRole.DIRECTOR;

// SUPER_ADMIN/ASSISTANT_ADMIN uchun hospitalId JWT'da null bo'ladi — ular
// targetHospitalId orqali istalgan shifoxonani ko'rishi mumkin. ADMIN/DIRECTOR
// uchun hospitalId har doim o'zining shifoxonasi (departments.controller.ts
// bilan bir xil naqsh).
function resolveHospitalId(
  jwtHospId: string | null,
  targetHospId?: string,
): string | null {
  return jwtHospId || targetHospId || null;
}

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class UsersController {
  constructor(
    private readonly service: UsersService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  @Roles(SUPER, ASST, ADMIN, DIR)
  findAll(
    @Query() query: QueryUsersDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findAll(
      query,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Patch(':id/status')
  @Roles(SUPER, ASST, ADMIN, DIR)
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const result = await this.service.updateStatus(
      id,
      dto.status,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
    this.auditLog.log({
      userId: actorId,
      hospitalId: hospitalId ?? undefined,
      action: 'UPDATE',
      entity: 'User',
      entityId: id,
      details: { status: dto.status },
    });
    return result;
  }

  @Patch(':id/role')
  @Roles(SUPER)
  async updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const result = await this.service.updateRole(
      id,
      dto.role,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
    this.auditLog.log({
      userId: actorId,
      hospitalId: hospitalId ?? undefined,
      action: 'UPDATE',
      entity: 'User',
      entityId: id,
      details: { role: dto.role },
    });
    return result;
  }

  /** Granular ruxsatlar (FAZA 5, 7-bosqich) — standart + override + effektiv ro'yxat. */
  @Get(':id/permissions')
  @Roles(SUPER, ASST, ADMIN, DIR)
  getPermissions(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.getPermissions(
      id,
      resolveHospitalId(hospitalId, targetHospitalId),
    );
  }

  @Patch(':id/permissions')
  @Roles(SUPER)
  async setPermission(
    @Param('id') id: string,
    @Body() dto: SetPermissionOverrideDto,
    @CurrentUser('sub') actorId: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const result = await this.service.setPermissionOverride(
      id,
      resolveHospitalId(hospitalId, targetHospitalId),
      dto.permission,
      dto.granted,
    );
    this.auditLog.log({
      userId: actorId,
      hospitalId: hospitalId ?? undefined,
      action: 'UPDATE',
      entity: 'User',
      entityId: id,
      details: { permission: dto.permission, granted: dto.granted ?? null },
    });
    return result;
  }
}
