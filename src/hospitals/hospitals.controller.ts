import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { HospitalsService } from './hospitals.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

const SUPER = UserRole.SUPER_ADMIN;
const ASST = UserRole.ASSISTANT_ADMIN;
const DIR = UserRole.DIRECTOR;

@Controller('hospitals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HospitalsController {
  constructor(private readonly svc: HospitalsService) {}

  @Get()
  @Roles(SUPER, ASST)
  async findAll(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const allowed = await this.svc.resolveAllowedHospitalIds(role, userId);
    return this.svc.findAll(allowed);
  }

  @Get(':id')
  @Roles(SUPER, ASST)
  async findOne(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const allowed = await this.svc.resolveAllowedHospitalIds(role, userId);
    if (allowed && !allowed.includes(id)) {
      throw new ForbiddenException(
        'Sizga bu shifoxonaga kirish huquqi berilmagan',
      );
    }
    return this.svc.findOne(id);
  }

  @Post()
  @Roles(SUPER)
  create(
    @Body()
    body: {
      name: string;
      code: string;
      address?: string;
      phone?: string;
    },
  ) {
    return this.svc.create(body);
  }

  /**
   * SUPER_ADMIN — barcha maydonlarni o'zgartira oladi.
   * ASSISTANT_ADMIN — faqat o'ziga biriktirilgan shifoxonaning nomi/manzil/
   * telefonini o'zgartira oladi (Odiljon so'rovi, 2026-09-19: "ko'rishi
   * tahrirlashi"); isActive/GPS kabi operatsion maydonlarga tegmaydi
   * (GPS uchun alohida gps-radius/gps-reset endpointlari bor).
   */
  @Put(':id')
  @Roles(SUPER, ASST)
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      address?: string;
      phone?: string;
      isActive?: boolean;
      gpsLat?: number;
      gpsLng?: number;
      gpsRadius?: number;
    },
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    if (role === ASST) {
      const allowed = await this.svc.resolveAllowedHospitalIds(role, userId);
      if (allowed && !allowed.includes(id)) {
        throw new ForbiddenException(
          'Sizga bu shifoxonani tahrirlash huquqi berilmagan',
        );
      }
      const { name, address, phone } = body;
      return this.svc.update(id, { name, address, phone });
    }
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
    @Body()
    body: {
      username: string;
      password: string;
      fullName: string;
      phone?: string;
    },
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
  updateGpsRadius(@Param('id') id: string, @Body('radius') radius: number) {
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

  /** SUPER_ADMIN: shifoxonaga biriktirilgan Assistant Admin'lar ro'yxati */
  @Get(':id/assistants')
  @Roles(SUPER)
  listAssistants(@Param('id') id: string) {
    return this.svc.listAssistants(id);
  }

  /** SUPER_ADMIN: bitta Assistant Admin'ni shifoxonaga biriktirish */
  @Post(':id/assistants')
  @Roles(SUPER)
  assignAssistant(@Param('id') id: string, @Body('userId') userId: string) {
    return this.svc.assignAssistant(id, userId);
  }

  /** SUPER_ADMIN: biriktirishni bekor qilish */
  @Delete(':id/assistants/:userId')
  @Roles(SUPER)
  unassignAssistant(@Param('id') id: string, @Param('userId') userId: string) {
    return this.svc.unassignAssistant(id, userId);
  }
}
