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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { HospitalsService } from './hospitals.service';
import { SetHospitalGpsDto } from './dto/set-hospital-gps.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SchedulePlanningMode, UserRole } from '@prisma/client';

const SUPER = UserRole.SUPER_ADMIN;
const ASST = UserRole.ASSISTANT_ADMIN;
const DIR = UserRole.DIRECTOR;
const ADMIN = UserRole.ADMIN;

interface HospitalActor {
  sub: string;
  role: UserRole;
  hospitalId?: string | null;
}

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

  /**
   * POST_COVERAGE faqat SUPER_ADMIN tomonidan aniq muassasa uchun yoqiladi.
   * Barcha mavjud va yangi muassasalar STANDARD holatda boshlaydi.
   */
  @Patch(':id/schedule-planning-mode')
  @Roles(SUPER)
  setSchedulePlanningMode(
    @Param('id') id: string,
    @Body('mode') mode: SchedulePlanningMode,
  ) {
    return this.svc.setSchedulePlanningMode(id, mode);
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

  /** GPS radius ni o'zgartirish (50–2000 metr). DIRECTOR — faqat o'z muassasasi. */
  @Patch(':id/gps-radius')
  @Roles(SUPER, ASST, DIR)
  async updateGpsRadius(
    @Param('id') id: string,
    @Body('radius') radius: number,
    @CurrentUser() user: HospitalActor,
  ) {
    await this.assertCanManageHospital(id, user);
    return this.svc.updateGpsRadius(id, Number(radius));
  }

  /** GPS markazini tozalash. DIRECTOR — faqat o'z muassasasi. */
  @Patch(':id/gps-reset')
  @Roles(SUPER, ASST, DIR)
  async resetGps(@Param('id') id: string, @CurrentUser() user: HospitalActor) {
    await this.assertCanManageHospital(id, user);
    return this.svc.resetGps(id);
  }

  /** Kasalxonaning barcha Telegram obunalarini o'chirish (eski direktor qoldiqlari uchun) */
  @Delete(':id/telegram-subs')
  @Roles(SUPER, ASST)
  async resetTelegramSubs(
    @Param('id') id: string,
    @CurrentUser() user: HospitalActor,
  ) {
    await this.assertCanManageHospital(id, user);
    return this.svc.resetTelegramSubs(id);
  }

  /**
   * XAVFSIZLIK (2026-09-23 audit): `:id` bilan ishlaydigan operatsion
   * endpointlar ilgari istalgan muassasa ID'sini qabul qilardi.
   * SUPER_ADMIN — hammasi; ASSISTANT_ADMIN — faqat biriktirilganlari;
   * DIRECTOR/ADMIN — faqat JWT'dagi o'z muassasasi.
   */
  private async assertCanManageHospital(id: string, user: HospitalActor) {
    if (user.role === SUPER) return;
    if (user.role === ASST) {
      const allowed = await this.svc.resolveAllowedHospitalIds(
        user.role,
        user.sub,
      );
      if (allowed?.includes(id)) return;
    } else if (user.hospitalId && user.hospitalId === id) {
      return;
    }
    throw new ForbiddenException(
      'Sizga bu muassasani boshqarish huquqi berilmagan',
    );
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

  // ─────────────────────────────────────────────────────────
  // Tenant self-service branding (2026-09-19, Odiljon so'rovi):
  // DIRECTOR/ADMIN o'z shifoxonasining nomi/logotipini o'zi sozlaydi.
  // DIQQAT: hospitalId HAR DOIM JWT'dan olinadi (mijoz yuborgan qiymatga
  // ishonilmaydi) — hikvision tuzatishidagi bilan bir xil naqsh.
  // ─────────────────────────────────────────────────────────

  /** O'z muassasasining geofence markazi va radiusi. */
  @Get('me/gps')
  @Roles(DIR, ADMIN)
  getOwnGps(@CurrentUser('hospitalId') hospitalId: string) {
    if (!hospitalId) throw new ForbiddenException('Shifoxona aniqlanmadi');
    return this.svc.getGps(hospitalId);
  }

  /**
   * Geofence markazini belgilash — Sozlamalarda xaritadan tanlangan nuqta
   * yoki "hozirgi joyimni markaz qilish" (accuracy bilan). Ilgari buni
   * muassasaning BIRINCHI check-in qilgan xodimi o'zi belgilardi.
   */
  @Put('me/gps')
  @Roles(DIR, ADMIN)
  setOwnGps(
    @CurrentUser('hospitalId') hospitalId: string,
    @Body() dto: SetHospitalGpsDto,
  ) {
    if (!hospitalId) throw new ForbiddenException('Shifoxona aniqlanmadi');
    return this.svc.setGps(hospitalId, dto);
  }

  @Patch('me')
  @Roles(DIR, ADMIN)
  updateOwnInfo(
    @Body('name') name: string,
    @CurrentUser('hospitalId') hospitalId: string,
  ) {
    if (!hospitalId) {
      throw new ForbiddenException('Shifoxona aniqlanmadi');
    }
    if (!name || !name.trim()) {
      throw new BadRequestException(
        "Shifoxona nomi bo'sh bo'lishi mumkin emas",
      );
    }
    return this.svc.updateOwnInfo(hospitalId, { name: name.trim() });
  }

  @Post('me/logo')
  @Roles(DIR, ADMIN)
  @UseInterceptors(FileInterceptor('logo', { storage: memoryStorage() }))
  updateOwnLogo(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('hospitalId') hospitalId: string,
  ) {
    if (!hospitalId) {
      throw new ForbiddenException('Shifoxona aniqlanmadi');
    }
    if (!file) {
      throw new BadRequestException('Logotip fayli yuklanmadi');
    }
    return this.svc.updateOwnLogo(hospitalId, file.buffer);
  }
}
