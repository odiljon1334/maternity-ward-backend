import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

/** Proxy orqali kelgan so'rovlarda ham haqiqiy IP ni olish */
function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  return req.ip ?? 'unknown';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Brute-force himoya: 15 daqiqada max 10 urinish */
  @Throttle({ login: { ttl: 900_000, limit: 10 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, getIp(req));
  }

  /**
   * Yangi global foydalanuvchi yaratish.
   * Faqat SUPER_ADMIN qila oladi.
   * Rol: MINISTRY (kuzatuvchi) yoki ASSISTANT_ADMIN (yordamchi).
   * Default: ASSISTANT_ADMIN
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('register')
  register(
    @Body() dto: RegisterDto,
    @CurrentUser('sub') createdByUserId: string,
  ) {
    return this.authService.register(dto, createdByUserId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@CurrentUser('sub') userId: string) {
    return this.authService.getProfile(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put('change-password')
  changePassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.authService.changePassword(userId, dto, getIp(req));
  }
}
