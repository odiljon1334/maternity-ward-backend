import {
  Controller, Get, Post, Put, Patch, Delete, Param, Body, UseGuards,
} from '@nestjs/common';
import { HospitalsService } from './hospitals.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

const SUPER = UserRole.SUPER_ADMIN;
const ASST  = UserRole.ASSISTANT_ADMIN;
const DIR   = UserRole.DIRECTOR;

@Controller('hospitals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HospitalsController {
  constructor(private readonly svc: HospitalsService) {}

  @Get()
  @Roles(SUPER, ASST)
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  @Roles(SUPER, ASST)
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @Roles(SUPER)
  create(@Body() body: { name: string; code: string; address?: string; phone?: string }) {
    return this.svc.create(body);
  }

  @Put(':id')
  @Roles(SUPER)
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; address?: string; phone?: string; isActive?: boolean },
  ) {
    return this.svc.update(id, body);
  }

  @Delete(':id')
  @Roles(SUPER)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Patch(':id/block')
  @Roles(SUPER)
  block(@Param('id') id: string) {
    return this.svc.setBlocked(id, true);
  }

  @Patch(':id/unblock')
  @Roles(SUPER)
  unblock(@Param('id') id: string) {
    return this.svc.setBlocked(id, false);
  }

  @Post(':id/directors')
  @Roles(SUPER)
  createDirector(
    @Param('id') id: string,
    @Body() body: { username: string; password: string; fullName: string; phone?: string },
  ) {
    return this.svc.createDirector(id, body);
  }

  @Patch(':id/directors')
  @Roles(SUPER)
  updateDirector(
    @Param('id') id: string,
    @Body() body: { fullName?: string; phone?: string; password?: string },
  ) {
    return this.svc.updateDirector(id, body);
  }

  /** DIRECTOR/SUPER: GPS radius ni o'zgartirish (50–2000 metr) */
  @Patch(':id/gps-radius')
  @Roles(SUPER, ASST, DIR)
  updateGpsRadius(
    @Param('id') id: string,
    @Body('radius') radius: number,
  ) {
    return this.svc.updateGpsRadius(id, Number(radius));
  }

  /** SUPER/DIRECTOR: GPS ni reset qilish (xodim qayta o'rnatishi uchun) */
  @Patch(':id/gps-reset')
  @Roles(SUPER, ASST, DIR)
  resetGps(@Param('id') id: string) {
    return this.svc.resetGps(id);
  }

  /** Kasalxonaning barcha Telegram obunalarini o'chirish (eski direktor qoldiqlari uchun) */
  @Delete(':id/telegram-subs')
  @Roles(SUPER, ASST)
  resetTelegramSubs(@Param('id') id: string) {
    return this.svc.resetTelegramSubs(id);
  }
}
