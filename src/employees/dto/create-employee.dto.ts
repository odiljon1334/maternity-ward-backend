import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsPositive,
  IsPhoneNumber,
  IsEmail,
  IsDateString,
} from 'class-validator';
import { Gender } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateEmployeeDto {
  @IsString()
  employeeNo: string;

  @IsString()
  fullName: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  departmentId: string;

  @IsString()
  positionId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  baseSalary: number;

  @IsOptional()
  @IsString()
  telegramChatId?: string;

  @IsOptional()
  @IsDateString()
  hiredAt?: string;
}
