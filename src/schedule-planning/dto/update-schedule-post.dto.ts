import { SchedulePostCoverageMode } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateSchedulePostDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @IsOptional()
  @IsEnum(SchedulePostCoverageMode)
  coverageMode?: SchedulePostCoverageMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  dailyCoverageMinutes?: number;

  /** Yakshanba (0) dan Shanba (6) gacha bo'lgan daqiqalar. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(1440, { each: true })
  coverageMinutesByWeekday?: number[];
}
