import {
  Controller,
  Post,
  Delete,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { HikvisionService } from './hikvision.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { AddPersonDto } from './hikvision.dto';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

const TERMINAL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
  UserRole.DIRECTOR,
  UserRole.ADMIN,
];

function isSuperLike(role: UserRole): boolean {
  return role === UserRole.SUPER_ADMIN;
}

@UseGuards(JwtAuthGuard)
@Controller('hikvision')
export class HikvisionController {
  constructor(private readonly hikvision: HikvisionService) {}

  // Gateway devices
  @Get('devices')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getDevices() {
    return this.hikvision.getDevices();
  }

  // Person
  @Post('devices/:devIndex/persons')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  addPerson(@Param('devIndex') devIndex: string, @Body() dto: AddPersonDto) {
    return this.hikvision.addPerson(devIndex, dto);
  }

  @Delete('devices/:devIndex/persons/:employeeNo')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  deletePerson(
    @Param('devIndex') devIndex: string,
    @Param('employeeNo') employeeNo: string,
  ) {
    return this.hikvision.deletePerson(devIndex, employeeNo);
  }

  // Face
  @Post('devices/:devIndex/persons/:employeeNo/face')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('image'))
  addFace(
    @Param('devIndex') devIndex: string,
    @Param('employeeNo') employeeNo: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.hikvision.addFacePicture(devIndex, employeeNo, file.buffer);
  }

  @Delete('devices/:devIndex/persons/:employeeNo/face')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  deleteFace(
    @Param('devIndex') devIndex: string,
    @Param('employeeNo') employeeNo: string,
  ) {
    return this.hikvision.deleteFacePicture(devIndex, employeeNo);
  }

  // ─────────────────────────────────────────────────────────
  // Terminallar — DIQQAT: DIRECTOR/ADMIN uchun hospitalId HAR DOIM
  // JWT'dan olinadi (mijoz yuborgan qiymatga ishonilmaydi). Faqat
  // SUPER_ADMIN so'rovda ko'rsatilgan hospitalId'dan (yoki "all"dan)
  // foydalanishi mumkin. Assistant Admin uchun qiymat TenantScopeGuard
  // tomonidan faqat biriktirilgan muassasaga almashtiriladi. Bu — boshqa shifoxonaning
  // terminaliga aralashish imkoniyatini yopadi (avval hech qanday
  // tekshiruv yo'q edi).
  // ─────────────────────────────────────────────────────────

  @Get('terminals')
  @UseGuards(RolesGuard, TenantScopeGuard)
  @Roles(...TERMINAL_ROLES)
  getTerminals(
    @Query('hospitalId') hospitalId: string,
    @CurrentUser('role') role: UserRole,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
  ) {
    if (isSuperLike(role)) {
      if (hospitalId === 'all') {
        return this.hikvision.getAllTerminalsWithStatus();
      }
      return this.hikvision.getTerminalsWithStatus(hospitalId);
    }
    if (!jwtHospitalId) {
      throw new ForbiddenException('Shifoxona aniqlanmadi');
    }
    return this.hikvision.getTerminalsWithStatus(jwtHospitalId);
  }

  @Post('terminals')
  @UseGuards(RolesGuard, TenantScopeGuard)
  @Roles(...TERMINAL_ROLES)
  addTerminal(
    @Body()
    body: {
      hospitalId: string;
      name: string;
      devIndex: string;
      password?: string;
    },
    @CurrentUser('role') role: UserRole,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
  ) {
    const hospitalId = isSuperLike(role) ? body.hospitalId : jwtHospitalId;
    if (!hospitalId) {
      throw new ForbiddenException('Shifoxona aniqlanmadi');
    }
    return this.hikvision.addTerminal(hospitalId, {
      name: body.name,
      devIndex: body.devIndex,
      password: body.password,
    });
  }

  @Delete('terminals/:id')
  @UseGuards(RolesGuard, TenantScopeGuard)
  @Roles(...TERMINAL_ROLES)
  deleteTerminal(
    @Param('id') id: string,
    @Query('hospitalId') hospitalId: string,
    @CurrentUser('role') role: UserRole,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
  ) {
    const scopedHospitalId = isSuperLike(role) ? hospitalId : jwtHospitalId;
    if (!scopedHospitalId) {
      throw new ForbiddenException('Shifoxona aniqlanmadi');
    }
    return this.hikvision.removeTerminal(id, scopedHospitalId);
  }

  @Patch('terminals/:id')
  @UseGuards(RolesGuard, TenantScopeGuard)
  @Roles(...TERMINAL_ROLES)
  toggleTerminal(
    @Param('id') id: string,
    @Body() body: { isActive: boolean; hospitalId: string },
    @CurrentUser('role') role: UserRole,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
  ) {
    const hospitalId = isSuperLike(role) ? body.hospitalId : jwtHospitalId;
    if (!hospitalId) {
      throw new ForbiddenException('Shifoxona aniqlanmadi');
    }
    return this.hikvision.toggleTerminal(id, hospitalId, body.isActive);
  }

  // Bulk sync — fon vazifasi: POST darhol javob beradi (ishlayotgan bo'lsa —
  // o'sha ish), GET — holat va progress. Ilgari bitta uzun so'rov edi va
  // proxy/brauzer uzilsa natija yo'qolardi.
  @Post('sync/:hospitalId')
  @UseGuards(RolesGuard, TenantScopeGuard)
  @Roles(...TERMINAL_ROLES)
  syncHospital(
    @Param('hospitalId') hospitalId: string,
    @CurrentUser('role') role: UserRole,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
  ) {
    if (!isSuperLike(role) && hospitalId !== jwtHospitalId) {
      throw new ForbiddenException("Bu shifoxonaga ruxsatingiz yo'q");
    }
    return this.hikvision.startSync(hospitalId);
  }

  @Get('sync/:hospitalId')
  @UseGuards(RolesGuard, TenantScopeGuard)
  @Roles(...TERMINAL_ROLES)
  syncStatus(
    @Param('hospitalId') hospitalId: string,
    @CurrentUser('role') role: UserRole,
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
  ) {
    if (!isSuperLike(role) && hospitalId !== jwtHospitalId) {
      throw new ForbiddenException("Bu shifoxonaga ruxsatingiz yo'q");
    }
    return this.hikvision.getSyncStatus(hospitalId);
  }

  // Reboot — faqat admin, chunki terminal ~30-90s offline bo'lib qoladi
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('devices/:devIndex/reboot')
  rebootTerminal(@Param('devIndex') devIndex: string) {
    return this.hikvision.rebootTerminal(devIndex);
  }
}
