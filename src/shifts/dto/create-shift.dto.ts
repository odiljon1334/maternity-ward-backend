import { IsString, IsEnum, IsInt, IsBoolean, IsOptional, Min, Max, Matches } from 'class-validator';
import { ShiftType } from '@prisma/client';

export class CreateShiftDto {
  @IsString()
  name: string;

  @IsEnum(ShiftType)
  type: ShiftType;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime HH:MM formatida bo\'lishi kerak' })
  startTime: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime HH:MM formatida bo\'lishi kerak' })
  endTime: string;

  @IsBoolean()
  @IsOptional()
  isOvernight?: boolean;

  @IsInt()
  durationH: number;

  @IsInt()
  @Min(0)
  @Max(60)
  @IsOptional()
  graceMinutes?: number;

  @IsString()
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'lunchStart HH:MM formatida bo\'lishi kerak' })
  lunchStart?: string;

  @IsString()
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'lunchEnd HH:MM formatida bo\'lishi kerak' })
  lunchEnd?: string;

  @IsInt()
  @Min(0)
  @Max(60)
  @IsOptional()
  lunchGraceMin?: number;
}
