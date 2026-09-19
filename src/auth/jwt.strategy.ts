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
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: {
    sub: string;
    role: string;
    username: string;
    hospitalId?: string;
  }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        status: true,
        username: true,
        hospitalId: true,
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
