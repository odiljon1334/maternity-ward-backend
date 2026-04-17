import { IsString, MinLength, IsEnum, IsOptional } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * SUPER_ADMIN yangi global foydalanuvchi yaratganda ishlatiladi.
 * Faqat quyidagi rollar tanlanishi mumkin:
 *   - MINISTRY       → Viloyat/Respublika vazirlik kuzatuvchisi (faqat o'qish)
 *   - ASSISTANT_ADMIN → Yordamchi admin
 *
 * ADMIN, DIRECTOR va boshqa rollar kasalxona ichida alohida yaratiladi.
 */
const ALLOWED_ROLES = [UserRole.MINISTRY, UserRole.ASSISTANT_ADMIN] as const;
export type AllowedRegisterRole = typeof ALLOWED_ROLES[number];

export class RegisterDto {
  @IsString()
  @MinLength(3)
  username: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsEnum(ALLOWED_ROLES, {
    message: `Rol faqat quyidagilardan biri bo'lishi mumkin: ${ALLOWED_ROLES.join(', ')}`,
  })
  role?: AllowedRegisterRole;
}
