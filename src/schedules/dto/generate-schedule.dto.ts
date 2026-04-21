import { IsEnum, IsInt, IsString, IsOptional, Min, Max, IsArray, ValidateNested, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ShiftType } from '@prisma/client';

export enum SchedulePattern {
  TWO_TWO    = '2-2',       // 2 hafta kunduzi, 2 hafta kechki
  ONE_ONE    = '1-1',       // 1 hafta kunduzi, 1 hafta kechki
  THREE_ONE  = '3-1',       // 3 hafta kunduzi, 1 hafta kechki
  FIXED_DAY  = 'FIXED_DAY', // Faqat kunduzgi (o'zgarmas)
  FIXED_NIGHT = 'FIXED_NIGHT', // Faqat kechki (o'zgarmas)
  CUSTOM     = 'custom',
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

  @IsOptional()
  @IsEnum(ShiftType)
  startsWith?: ShiftType;  // FIXED_DAY/FIXED_NIGHT uchun shart emas

  // Qaysi kun ishlaydi: 0=Yak, 1=Du, 2=Se, 3=Ch, 4=Pa, 5=Sha, 6=Yak
  // Default: [1,2,3,4,5] — Dushanba-Juma (5-kunlik)
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  workDays?: number[];

  // Bitta xodim uchun aniq shift (startTime belgilash)
  @IsOptional()
  @IsString()
  shiftId?: string;

  // Custom pattern uchun: har hafta uchun shift type
  @IsOptional()
  @IsArray()
  customWeeks?: ShiftType[];
}

export class BulkGenerateScheduleDto {
  // Bo'sh yoki yuborilmagan holda hospitalId + departmentId bo'yicha topiladi
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeIds?: string[];

  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2024)
  year: number;

  @IsEnum(SchedulePattern)
  pattern: SchedulePattern;

  @IsOptional()
  @IsEnum(ShiftType)
  startsWith?: ShiftType;  // FIXED_DAY/FIXED_NIGHT uchun shart emas

  // Qaysi kun ishlaydi: 0=Yak, 1=Du, 2=Se, 3=Ch, 4=Pa, 5=Sha, 6=Yak
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  workDays?: number[];

  // Bo'lim bo'yicha filter (SUPER_ADMIN uchun)
  @IsOptional()
  @IsString()
  departmentId?: string;
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
