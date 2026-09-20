import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { computeEffectivePermissions, Permission } from '../common/permissions';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      // Browser sessiyasi HttpOnly cookie'da bo'ladi. Bearer extractor esa
      // mobil/integratsiya mijozlari va xavfsiz rollout uchun qoladi.
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request) => {
          const cookie = request?.headers?.cookie;
          const match = cookie?.match(/(?:^|;\s*)access_token=([^;]+)/);
          return match ? decodeURIComponent(match[1]) : null;
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: {
    sub: string;
    role: string;
    username: string;
    hospitalId?: string;
    iat?: number;
  }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        status: true,
        username: true,
        hospitalId: true,
        credentialsChangedAt: true,
        // Granular ruxsatlar (FAZA 5, 7-bosqich) — bir xil so'rovda,
        // qo'shimcha DB chaqiruvisiz olinadi (deyarli har doim bo'sh massiv).
        permissionOverrides: {
          select: { permission: true, granted: true },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Token yaroqsiz');
    }
    if (
      user.credentialsChangedAt &&
      (!payload.iat ||
        payload.iat < Math.floor(user.credentialsChangedAt.getTime() / 1000))
    ) {
      throw new UnauthorizedException(
        'Sessiya parol o‘zgargani uchun tugatilgan',
      );
    }
    const permissions: Permission[] = computeEffectivePermissions(
      user.role,
      user.permissionOverrides,
    );
    return {
      sub: user.id,
      role: user.role,
      username: user.username,
      hospitalId: user.hospitalId ?? null,
      permissions,
    };
  }
}
