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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SchedulePlanEntryInputDto)
  entries: SchedulePlanEntryInputDto[];
}
