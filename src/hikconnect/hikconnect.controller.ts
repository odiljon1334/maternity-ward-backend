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

@UseGuards(JwtAuthGuard, RolesGuard)
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
  getCameras(@Query('hospitalId') hospitalId?: string) {
    return this.svc.getAllCameras(hospitalId);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Post('cameras')
  createCamera(@Body() dto: CreateCameraDto) {
    return this.svc.createCamera(dto);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Put('cameras/:id')
  updateCamera(@Param('id') id: string, @Body() dto: UpdateCameraDto) {
    return this.svc.updateCamera(id, dto);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Delete('cameras/:id')
  deleteCamera(@Param('id') id: string) {
    return this.svc.deleteCamera(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN)
  @Get('devices/:serial/detail')
  getDeviceDetail(@Param('serial') serial: string) {
    return this.svc.getDeviceDetail(serial);
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
  getLiveUrl(@Param('id') id: string) {
    return this.svc.getLiveUrlById(id);
  }
}
