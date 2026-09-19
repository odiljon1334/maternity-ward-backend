import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { Permission } from '../permissions';

/**
 * RolesGuard'dan KEYIN ishlaydi (ikkalasi ham @UseGuards ro'yxatida).
 * @RequirePermission belgilanmagan endpoint'larda hech narsa qilmaydi
 * (true qaytaradi) — shuning uchun mavjud, hali bu tizimga
 * o'tkazilmagan barcha endpoint'lar avvalgidek ishlashda davom etadi.
 * request.user.permissions — JwtStrategy.validate()da
 * computeEffectivePermissions() orqali oldindan hisoblab qo'yiladi.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    const effective: string[] = user?.permissions ?? [];
    const allowed = required.some((p) => effective.includes(p));
    if (!allowed) {
      throw new ForbiddenException("Bu amal uchun ruxsatingiz yo'q");
    }
    return true;
  }
}
