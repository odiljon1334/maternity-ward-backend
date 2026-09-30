import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { SchedulePlanEntryType } from '@prisma/client';

export class SchedulePlanEntryInputDto {
  @IsString()
  employeeId: string;

  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsEnum(SchedulePlanEntryType)
  entryType: SchedulePlanEntryType;

  @IsOptional()
  @IsBoolean()
  countsTowardPostCoverage?: boolean;

  @IsDateString()
  workDate: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class SaveSchedulePlanEntriesDto {
  /**
   * Tahrir boshlangan paytdagi reja `updatedAt` qiymati. Berilsa, reja
   * orada boshqa foydalanuvchi tomonidan saqlangan bo'lsa 409 qaytadi
   * (bir-birining ishini bildirmasdan o'chirib yubormaslik uchun).
   */
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SchedulePlanEntryInputDto)
  entries: SchedulePlanEntryInputDto[];
}
