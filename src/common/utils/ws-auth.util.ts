import type { IncomingMessage } from 'http';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface SocketUser {
  id: string;
  role: UserRole;
  hospitalId: string | null;
}

/** `access_token` cookie'sini (HttpOnly sessiya) o'qish */
export function tokenFromCookie(cookieHeader?: string | null): string | null {
  const m = String(cookieHeader ?? '').match(/(?:^|;\s*)access_token=([^;]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export function tokenFromRequest(req?: IncomingMessage | null): string | null {
  return tokenFromCookie(req?.headers?.cookie);
}

/**
 * WebSocket uchun HTTP JwtStrategy bilan bir xil tekshiruv: imzo + muddat,
 * foydalanuvchi bazada ACTIVE, parol almashgandan keyingi eski token rad.
 * Ilgari socketlar faqat `jwt.verify` qilardi (bloklangan/parolini
 * almashtirgan foydalanuvchi ham ulanaverardi), `/ws/audio` esa umuman
 * tekshirmasdi.
 */
export async function verifySocketUser(
  jwt: JwtService,
  prisma: PrismaService,
  token: string | null | undefined,
): Promise<SocketUser | null> {
  if (!token) return null;
  let payload: { sub?: string; iat?: number };
  try {
    payload = await jwt.verifyAsync(
      token,
      process.env.JWT_SECRET ? { secret: process.env.JWT_SECRET } : undefined,
    );
  } catch {
    return null;
  }
  if (!payload?.sub) return null;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      role: true,
      status: true,
      hospitalId: true,
      credentialsChangedAt: true,
    },
  });
  if (!user || user.status !== 'ACTIVE') return null;
  if (
    user.credentialsChangedAt &&
    (!payload.iat ||
      payload.iat < Math.floor(user.credentialsChangedAt.getTime() / 1000))
  ) {
    return null;
  }
  return { id: user.id, role: user.role, hospitalId: user.hospitalId ?? null };
}
