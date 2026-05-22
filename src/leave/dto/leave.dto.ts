import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { LeaveType } from '@prisma/client';

export class CreateLeaveDto {
  @IsEnum(LeaveType)
  type: LeaveType;

  @IsDateString()
  startDate: string; // "YYYY-MM-DD"

  @IsDateString()
  endDate: string; // "YYYY-MM-DD"

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ReviewLeaveDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  reviewNote?: string;
}

export class LeaveQueryDto {
  @IsOptional()
  @IsEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'])
  status?: string;

  @IsOptional()
  @IsString()
  targetHospitalId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
