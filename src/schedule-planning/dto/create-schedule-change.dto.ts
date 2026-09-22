import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ScheduleChangeType, SchedulePlanEntryType } from '@prisma/client';

export class CreateScheduleChangeDto {
  @IsEnum(ScheduleChangeType)
  type: ScheduleChangeType;

  @IsString()
  primaryEntryId: string;

  @IsOptional()
  @IsString()
  counterpartEntryId?: string;

  @IsOptional()
  @IsString()
  replacementEmployeeId?: string;

  @IsOptional()
  @IsEnum(SchedulePlanEntryType)
  absenceEntryType?: SchedulePlanEntryType;

  @IsString()
  @MinLength(3)
  reason: string;
}
