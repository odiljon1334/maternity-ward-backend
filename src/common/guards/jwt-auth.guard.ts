import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isHospitalBlocked } from '../utils/payment.util';

/** Muassasaga bog'liq rollar — muassasa bloklansa faqat o'qish rejimi */
const TENANT_ROLES: ReadonlySet<string> = new Set([
  UserRole.ADMIN,
  UserRole.DIRECTOR,
  UserRole.DEPARTMENT_HEAD,
  UserRole.EMPLOYEE,
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Bloklangan muassasa ham shu yo'llardan foydalana oladi: kirish/chiqish va
 * parol, to'lov (blokdan chiqish yo'li), bildirishnomalarni o'qildi deb
 * belgilash va push obunasi.
 */
const BLOCK_ALLOWED_PATH =
  /^\/(?:api\/v1\/)?(?:auth|payments|notifications|push)(?:\/|$)/;

export function isBlockExemptRequest(method: string, url: string): boolean {
  if (SAFE_METHODS.has(String(method).toUpperCase())) return true;
  const path = String(url || '').split('?')[0];
  return BLOCK_ALLOWED_PATH.test(path);
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw (
        err || new UnauthorizedException('Token yaroqsiz yoki muddati tugagan')
      );
    }
    return user;
  }

  /**
   * Muassasa bloklangan bo'lsa (admin bloki yoki BILLING_AUTO_BLOCK) — xodim
   * va rahbarlar ma'lumotlarni ko'ra oladi, lekin o'zgartira olmaydi.
   * Ilgari blok faqat check-in va oylikda tekshirilardi, qolgan barcha API
   * odatdagidek ishlayverardi.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok || context.getType() !== 'http') return ok;

    const req = context.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.hospitalId || !TENANT_ROLES.has(user.role)) return true;
    if (isBlockExemptRequest(req.method, req.originalUrl ?? req.url)) {
      return true;
    }
    if (await isHospitalBlocked(this.prisma, user.hospitalId)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'HOSPITAL_BLOCKED',
        message:
          "Muassasa bloklangan — faqat ko'rish rejimi. Davom etish uchun to'lovni amalga oshiring.",
      });
    }
    return true;
  }
}
