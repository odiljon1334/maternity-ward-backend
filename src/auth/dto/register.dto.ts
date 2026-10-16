import {
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * SUPER_ADMIN foydalanuvchi yaratganda ishlatiladi. SUPER_ADMIN bu ro'yxatda
 * ataylab yo'q: tizimda u yagona bo'ladi va UI/API orqali ko'paytirilmaydi.
 * Muassasa rollari uchun `hospitalId`, xodim/bo'lim boshlig'i uchun esa
 * mavjud xodimga xavfsiz ulash maqsadida `employeeId` ham talab qilinadi.
 */
const ALLOWED_ROLES = [
  UserRole.MINISTRY,
  UserRole.ASSISTANT_ADMIN,
  UserRole.ADMIN,
  UserRole.DIRECTOR,
  UserRole.DEPARTMENT_HEAD,
  UserRole.EMPLOYEE,
] as const;
export type AllowedRegisterRole = (typeof ALLOWED_ROLES)[number];

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

  @IsOptional()
  @IsUUID('4', { message: "Muassasa identifikatori noto'g'ri" })
  hospitalId?: string;

  @IsOptional()
  @IsUUID('4', { message: "Xodim identifikatori noto'g'ri" })
  employeeId?: string;
}
