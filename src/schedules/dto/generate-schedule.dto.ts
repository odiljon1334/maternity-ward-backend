import { IsEnum, IsInt, IsString, IsOptional, Min, Max, IsArray, ValidateNested, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ShiftType } from '@prisma/client';

export enum SchedulePattern {
  TWO_TWO = '2-2',    // 2 hafta kunduzi, 2 hafta kechki
  ONE_ONE = '1-1',    // 1 hafta kunduzi, 1 hafta kechki
  THREE_ONE = '3-1',  // 3 hafta kunduzi, 1 hafta kechki
  CUSTOM = 'custom',
}

export class GenerateScheduleDto {
  @IsString()
  employeeId: string;

  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2024)
  year: number;

  @IsEnum(SchedulePattern)
  pattern: SchedulePattern;

  @IsEnum(ShiftType)
  startsWith: ShiftType;  // birinchi hafta qaysi smen

  // Custom pattern uchun: har hafta uchun shift type
  @IsOptional()
  @IsArray()
  customWeeks?: ShiftType[];
}

export class BulkGenerateScheduleDto {
  @IsArray()
  @IsString({ each: true })
  employeeIds: string[];

  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2024)
  year: number;

  @IsEnum(SchedulePattern)
  pattern: SchedulePattern;

  @IsEnum(ShiftType)
  startsWith: ShiftType;
}

export class ManualScheduleEntryDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class BulkManualScheduleDto {
  @IsString()
  employeeId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualScheduleEntryDto)
  entries: ManualScheduleEntryDto[];
}
