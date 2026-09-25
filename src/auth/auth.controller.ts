import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateEmailDto } from './dto/update-email.dto';
import { VerifyEmailOtpDto } from './dto/verify-email-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyResetOtpDto } from './dto/verify-reset-otp.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

/** Proxy orqali kelgan so'rovlarda ham haqiqiy IP ni olish */
function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded)
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(',')[0]
      .trim();
  return req.ip ?? 'unknown';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Brute-force himoya: 15 daqiqada max 10 urinish */
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 10 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, getIp(req));
    this.setSessionCookie(req, res, result.accessToken);
    // JWT JavaScript javobiga qaytarilmaydi — uni faqat HttpOnly cookie olib yuradi.
    return { user: result.user };
  }

  /**
   * Mobil ilova (StaffPlusPRO, Android) — cookie emas, token javobda
   * qaytariladi va qurilmaning xavfsiz xotirasida (SecureStore) saqlanadi.
   * Hozircha faqat xodimlar uchun (ilova — check-in va ish vaqtidagi GPS).
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 10 } })
  @Post('mobile/login')
  async mobileLogin(@Body() dto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(dto, getIp(req));
    if (result.user.role !== UserRole.EMPLOYEE) {
      throw new ForbiddenException(
        'Mobil ilova hozircha faqat xodimlar uchun. Rahbarlar veb-saytdan foydalanadi.',
      );
    }
    return { accessToken: result.accessToken, user: result.user };
  }

  /** Mobil: muddati tugamagan token bilan yangisini olish (sliding sessiya) */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 30 } })
  @Post('mobile/refresh')
  mobileRefresh(@CurrentUser('sub') userId: string) {
    return this.authService.refreshMobileToken(userId);
  }

  /** Eski UI tokenini bir marta HttpOnly cookie'ga o‘tkazish. */
  @UseGuards(JwtAuthGuard)
  @Post('browser-session')
  browserSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) throw new UnauthorizedException('Bearer token talab qilinadi');
    this.setSessionCookie(req, res, token);
    return { migrated: true };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Avvalgi API host-only cookie ham, yangi umumiy domen cookie ham o'chadi.
    res.clearCookie('access_token', this.cookieOptions());
    const domain = this.sharedCookieDomain(req);
    if (domain) {
      res.clearCookie('access_token', this.cookieOptions(domain));
    }
    return { loggedOut: true };
  }

  private cookieOptions(domain?: string) {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      ...(domain && { domain }),
    };
  }

  private sharedCookieDomain(req: Request): string | undefined {
    const apiHost = req.hostname.toLowerCase();
    const origins = (process.env.FRONTEND_URL || '').split(',');
    for (const origin of origins) {
      try {
        const frontendHost = new URL(origin.trim()).hostname.toLowerCase();
        // API subdomenida yozilgan host-only cookie asosiy saytda ko'rinmaydi.
        // Faqat FRONTEND_URL API hostining ota domeni bo'lsa ulashamiz.
        if (
          frontendHost.includes('.') &&
          apiHost.endsWith(`.${frontendHost}`)
        ) {
          return frontendHost;
        }
      } catch {
        // Noto'g'ri URL cookie domenini kengaytirmaydi.
      }
    }
    return undefined;
  }

  private setSessionCookie(req: Request, res: Response, token: string) {
    // JWT_EXPIRES_IN standartda 7d. Cookie server tokenidan uzoq yashamasligi
    // uchun faqat d/h/m/s birliklarini qabul qilamiz.
    const raw = process.env.JWT_EXPIRES_IN || '7d';
    const match = /^(\d+)([dhms])$/.exec(raw);
    const unit = match?.[2];
    const multiplier =
      unit === 'd'
        ? 86_400_000
        : unit === 'h'
          ? 3_600_000
          : unit === 'm'
            ? 60_000
            : 1_000;
    const maxAge = (match ? Number(match[1]) : 7 * 24 * 60 * 60) * multiplier;
    const domain = this.sharedCookieDomain(req);
    if (domain) {
      // Eski host-only cookie qolsa, API ga bir xil nomli ikki cookie boradi.
      // JWT extractor eskisini olib qo'ymasligi uchun uni birinchi o'chiramiz.
      res.clearCookie('access_token', this.cookieOptions());
    }
    res.cookie('access_token', token, {
      ...this.cookieOptions(domain),
      maxAge,
    });
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

  // ─────────────────────────────────────────────────────────
  // Email tasdiqlash (login qilingan foydalanuvchi uchun)
  // ─────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Put('email')
  updateEmail(@CurrentUser('sub') userId: string, @Body() dto: UpdateEmailDto) {
    return this.authService.updateEmail(userId, dto);
  }

  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 5 } })
  @Post('email/resend-otp')
  resendEmailOtp(@CurrentUser('sub') userId: string) {
    return this.authService.resendEmailOtp(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('email/verify-otp')
  verifyEmailOtp(
    @CurrentUser('sub') userId: string,
    @Body() dto: VerifyEmailOtpDto,
  ) {
    return this.authService.verifyEmailOtp(userId, dto);
  }

  // ─────────────────────────────────────────────────────────
  // Parolni tiklash (login qilinmagan holatda, ochiq endpointlar)
  // ─────────────────────────────────────────────────────────

  /** Brute-force himoya: 15 daqiqada max 5 urinish */
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 5 } })
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  /** Email havolasidagi token bilan yangi parol qo'yish */
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 10 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  /** Telegram/SMS orqali kelgan OTP kod bilan yangi parol qo'yish */
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { ttl: 900_000, limit: 10 } })
  @Post('reset-password/otp')
  verifyResetOtp(@Body() dto: VerifyResetOtpDto) {
    return this.authService.verifyResetOtp(dto);
  }
}
