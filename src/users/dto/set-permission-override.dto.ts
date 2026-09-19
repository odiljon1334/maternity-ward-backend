import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PERMISSIONS, Permission } from '../../common/permissions';

export class SetPermissionOverrideDto {
  @IsIn(PERMISSIONS)
  permission!: Permission;

  // true = standartga qo'shimcha ruxsat berish, false = standartdan olib
  // tashlash, undefined/null = standart holatga qaytarish (override o'chiriladi)
  @IsOptional()
  @IsBoolean()
  granted?: boolean | null;
}
