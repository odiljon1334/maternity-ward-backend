import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsDateString,
  ValidateIf,
  IsEmail,
  Matches,
} from 'class-validator';
import { PINFL_FORMAT_MESSAGE } from '../../common/utils/pinfl.util';
import { Gender } from '@prisma/client';
import { Type, Transform } from 'class-transformer';

export class CreateEmployeeDto {
  @IsOptional()
  @IsString()
  employeeNo?: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsOptional()
  @IsString()
  phone?: string;

  // Email: only validate if provided and non-empty
  @IsOptional()
  @ValidateIf((o) => o.email && o.email.trim() !== '')
  @IsEmail({}, { message: "Email noto'g'ri formatda" })
  @Transform(({ value }) => (value === '' ? undefined : value))
  email?: string;

  @IsString()
  departmentId: string;

  @IsString()
  positionId: string;

  // baseSalary — optional, default 0 (director biriktiradi keyinroq)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  baseSalary?: number;

  @IsOptional()
  @IsString()
  telegramChatId?: string;

  @IsOptional()
  @IsDateString()
  hiredAt?: string;

  /** JSHSHIR (PINFL) — ixtiyoriy, 14 raqam. Bo'sh qator — o'chirish. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @ValidateIf((o) => o.pinfl !== null && o.pinfl !== '')
  @Matches(/^\d{14}$/, { message: PINFL_FORMAT_MESSAGE })
  pinfl?: string | null;
}
