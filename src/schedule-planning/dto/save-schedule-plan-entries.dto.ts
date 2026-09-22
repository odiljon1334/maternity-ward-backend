import { Type } from 'class-transformer';
import {
  IsArray,
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
