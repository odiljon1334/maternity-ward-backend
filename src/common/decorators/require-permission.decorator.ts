import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permissions';

export const PERMISSION_KEY = 'permission';

/**
 * Mavjud @Roles()ga QO'SHIMCHA — endpoint allaqachon @Roles orqali
 * ochilgan rollar ICHIDA, alohida foydalanuvchi uchun standartdan chetga
 * chiqishga (UserPermissionOverride orqali) imkon beradi. @Roles'ni
 * ALMASHTIRMAYDI — ikkalasi ham birga ishlatiladi.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
