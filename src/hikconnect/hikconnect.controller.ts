import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { HikConnectService } from './hikconnect.service';
import { CreateCameraDto, UpdateCameraDto } from './dto/camera.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Controller('hikconnect')
export class HikConnectController {
  constructor(private readonly svc: HikConnectService) {}

  // ─── Status ────────────────────────────────────────────────────────────────

  /** HikConnect + MediaMTX sozlamalar holati */
  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN, UserRole.MINISTRY)
  @Get('status')
  getStatus() {
    return this.svc.getStatus();
  }

  // ─── Camera CRUD ───────────────────────────────────────────────────────────

  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.MINISTRY,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
  )
  @Get('cameras')
  getCameras(
    @Query('hospitalId') requestedHospitalId: string | undefined,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    const scope =
      role === UserRole.SUPER_ADMIN || role === UserRole.MINISTRY
        ? requestedHospitalId
        : hospitalId;
    return this.svc.getAllCameras(scope ?? undefined);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Post('cameras')
  createCamera(
    @Body() dto: CreateCameraDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.svc.createCamera({
      ...dto,
      hospitalId: role === UserRole.SUPER_ADMIN ? dto.hospitalId : hospitalId!,
    });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Put('cameras/:id')
  updateCamera(
    @Param('id') id: string,
    @Body() dto: UpdateCameraDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    return this.svc.updateCamera(id, dto, hospitalId ?? undefined);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Delete('cameras/:id')
  deleteCamera(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    return this.svc.deleteCamera(id, hospitalId ?? undefined);
  }

  // ─── Live Stream ───────────────────────────────────────────────────────────

  /**
   * Kamera ID bo'yicha HLS stream URL olish.
   * MediaMTX yoki HikConnect — avtomatik tanlaydi.
   */
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ASSISTANT_ADMIN,
    UserRole.MINISTRY,
    UserRole.ADMIN,
    UserRole.DIRECTOR,
  )
  @Get('cameras/:id/live')
  getLiveUrl(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    const scope =
      role === UserRole.SUPER_ADMIN || role === UserRole.MINISTRY
        ? undefined
        : (hospitalId ?? undefined);
    return this.svc.getLiveUrlById(id, scope);
  }

  // ─── HikConnect import (keyinroq) ─────────────────────────────────────────

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Get('fetch-cameras')
  fetchFromHikConnect(
    @Query('pageIndex') pageIndex?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.fetchCamerasFromHikConnect({
      pageIndex: pageIndex ? Number(pageIndex) : 1,
      pageSize: pageSize ? Number(pageSize) : 100,
    });
  }
}
