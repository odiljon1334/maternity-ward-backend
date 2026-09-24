import type { NextFunction, Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { tokenFromCookie, verifySocketUser } from '../utils/ws-auth.util';

/** Selfini ko'ra oladigan rollar (xodimning o'zi — alohida tekshiriladi) */
const MANAGER_ROLES: ReadonlySet<string> = new Set([
  UserRole.SUPER_ADMIN,
  UserRole.ASSISTANT_ADMIN,
  UserRole.DIRECTOR,
  UserRole.ADMIN,
  UserRole.DEPARTMENT_HEAD,
]);

function bearer(req: Request): string | null {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
}

/**
 * `/uploads/selfies/*` — check-in selfilari shaxsiy ma'lumot. Ilgari ular
 * hamma uchun ochiq statik fayl edi (30 kunlik public kesh bilan). Endi:
 * tizimga kirgan va shu selfi muassasasiga tegishli rahbar yoki xodimning
 * o'zi. Qolgan yuklamalar (profil rasmlari, logotiplar) avvalgidek ochiq.
 *
 * Bot va yuz tekshiruvi selfilarni diskdan o'qiydi — ularga ta'sir yo'q.
 */
export function privateSelfiesMiddleware(
  jwt: JwtService,
  prisma: PrismaService,
) {
  return async function privateSelfies(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const user = await verifySocketUser(
        jwt,
        prisma,
        tokenFromCookie(req.headers.cookie) ?? bearer(req),
      );
      if (!user) return res.status(401).json({ message: 'Unauthorized' });

      const url = `/uploads/selfies${decodeURIComponent(req.path)}`;
      const rec = await prisma.attendanceRecord.findFirst({
        where: { OR: [{ selfieUrl: url }, { checkOutSelfieUrl: url }] },
        select: { employee: { select: { hospitalId: true, userId: true } } },
      });
      if (!rec) return res.status(404).json({ message: 'Not found' });

      const hid = rec.employee.hospitalId;
      let allowed = false;
      if (user.role === UserRole.SUPER_ADMIN) allowed = true;
      else if (rec.employee.userId === user.id) allowed = true;
      else if (user.role === UserRole.ASSISTANT_ADMIN) {
        allowed = !!(await prisma.hospitalAssistant.findFirst({
          where: { userId: user.id, hospitalId: hid },
          select: { hospitalId: true },
        }));
      } else if (MANAGER_ROLES.has(user.role)) {
        allowed = user.hospitalId === hid;
      }
      if (!allowed) return res.status(404).json({ message: 'Not found' });
      return next();
    } catch {
      return res.status(404).json({ message: 'Not found' });
    }
  };
}
