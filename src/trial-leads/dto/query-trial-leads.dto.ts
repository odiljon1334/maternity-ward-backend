import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TrialLeadSource, TrialLeadStatus } from '@prisma/client';

export class QueryTrialLeadsDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(TrialLeadSource)
  source?: TrialLeadSource;

  @IsOptional()
  @IsEnum(TrialLeadStatus)
  status?: TrialLeadStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
