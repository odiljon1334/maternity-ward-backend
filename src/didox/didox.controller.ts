import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { DidoxService } from './didox.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { DidoxChallengeDto } from './dto/didox-challenge.dto';
import { DidoxRegisterDto } from './dto/didox-register.dto';
import { DidoxLoginDto } from './dto/didox-login.dto';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

function resolveHospitalId(jwtHospId: string | null): string {
  if (!jwtHospId) {
    throw new Error("Foydalanuvchi biror shifoxonaga bog'lanmagan");
  }
  return jwtHospId;
}

// Faqat buxgalteriya/rahbariyat darajasidagi rollar Didox ulanishini
// boshqara oladi — bu ЭЦП va rasmiy hujjat aylanishiga tegishli operatsiya.
const DIDOX_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
];

@Controller('didox')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles(...DIDOX_ROLES)
export class DidoxController {
  constructor(private readonly didox: DidoxService) {}

  @Get('status')
  getStatus(@CurrentUser('hospitalId') hospitalId: string | null) {
    return this.didox.getStatus(resolveHospitalId(hospitalId));
  }

  @Post('challenge')
  getChallenge(
    @Body() body: DidoxChallengeDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    return this.didox.getChallenge(
      resolveHospitalId(hospitalId),
      body.serialNumber,
    );
  }

  @Post('register')
  register(
    @Body() body: DidoxRegisterDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    return this.didox.register(resolveHospitalId(hospitalId), body);
  }

  @Post('login')
  login(
    @Body() body: DidoxLoginDto,
    @CurrentUser('hospitalId') hospitalId: string | null,
  ) {
    return this.didox.login(resolveHospitalId(hospitalId), body);
  }

  @Delete('disconnect')
  disconnect(@CurrentUser('hospitalId') hospitalId: string | null) {
    return this.didox.disconnect(resolveHospitalId(hospitalId));
  }
}
