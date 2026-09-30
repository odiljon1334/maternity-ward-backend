import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  decideMediaMtxAccess,
  isPrivateIp,
  MediaMtxAuthRequest,
  streamPathCandidates,
} from './live-access';

/** Kamera jonli efirini ko'ra oladigan rollar (cameras/:id/live bilan bir xil) */
const VIEWER_ROLES: ReadonlySet<string> = new Set([
  UserRole.SUPER_ADMIN,
  UserRole.MINISTRY,
  UserRole.ASSISTANT_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
]);

/**
 * Kamera oqimlariga kirish nazorati.
 *
 * TenantScopeGuard ishlatilmaydi: nginx subrequest'ida targetHospitalId yo'q,
 * ASSISTANT_ADMIN esa bir nechta muassasaga biriktirilgan bo'lishi mumkin —
 * kamera muassasasi to'g'ridan-to'g'ri tekshiriladi.
 */
@Controller()
export class LiveAccessController {
  private readonly logger = new Logger(LiveAccessController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * nginx `auth_request` — `/live/...` HLS so'rovlari. 204 — ruxsat,
   * 401 — tizimga kirmagan, 403 — boshqa muassasa kamerasi.
   */
  @Get('hikconnect/live-auth')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async liveAuth(
    @Headers('x-original-uri') originalUri: string | undefined,
    @CurrentUser()
    user: { sub: string; role: string; hospitalId: string | null },
  ): Promise<void> {
    const candidates = streamPathCandidates(originalUri);
    if (!candidates.length) throw new NotFoundException();
    if (!VIEWER_ROLES.has(user.role)) throw new ForbiddenException();

    const camera = await this.prisma.camera.findFirst({
      where: { streamPath: { in: candidates }, isActive: true },
      select: { hospitalId: true },
    });
    if (!camera) throw new ForbiddenException();

    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MINISTRY) {
      return;
    }
    if (user.role === UserRole.ASSISTANT_ADMIN) {
      const assigned = await this.prisma.hospitalAssistant.findFirst({
        where: { userId: user.sub, hospitalId: camera.hospitalId },
        select: { hospitalId: true },
      });
      if (assigned) return;
      throw new ForbiddenException();
    }
    if (user.hospitalId && user.hospitalId === camera.hospitalId) return;
    throw new ForbiddenException();
  }

  /**
   * MediaMTX `authMethod: http` — har bir yuborish/o'qishda chaqiriladi.
   * Faqat ichki tarmoqdan (MediaMTX konteyneri) qabul qilinadi; nginx
   * orqali kelgan (X-Forwarded-For bor) so'rov rad etiladi.
   */
  @Post('internal/mediamtx-auth')
  @HttpCode(200)
  mediaMtxAuth(
    @Req() req: Request,
    @Body() body: MediaMtxAuthRequest,
  ): { ok: true } {
    const direct =
      !req.headers['x-forwarded-for'] &&
      isPrivateIp(req.socket?.remoteAddress ?? null);
    if (!direct) throw new NotFoundException();

    if (decideMediaMtxAccess(body ?? {})) return { ok: true };
    this.logger.warn(
      `MediaMTX rad etildi: action=${body?.action} path=${body?.path} ip=${body?.ip} user=${body?.user ? 'bor' : "yo'q"}`,
    );
    throw new UnauthorizedException();
  }
}
