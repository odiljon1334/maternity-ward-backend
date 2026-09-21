import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { TrialLeadStatus } from '@prisma/client';

export class UpdateTrialLeadDto {
  @IsEnum(TrialLeadStatus)
  status: TrialLeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
