import { AttendanceNoticeReason } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateNoticeDto {
  @IsEnum(AttendanceNoticeReason)
  reason: AttendanceNoticeReason;

  /** Taxminiy kechikish, daqiqa (5 daqiqadan 8 soatgacha) */
  @IsInt()
  @Min(5)
  @Max(480)
  delayMinutes: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  comment?: string;
}
