import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PayrollAdjustmentType } from '@prisma/client';

export class CreateAdjustmentDto {
  @IsString()
  employeeId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @Type(() => Number)
  @IsInt()
  @Min(2020)
  year: number;

  @IsEnum(PayrollAdjustmentType)
  type: PayrollAdjustmentType;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  proposedAmount: number;

  @IsString()
  reason: string;

  @IsOptional()
  @IsString()
  policyReference?: string;

  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  calculationBaseAmount?: number;
}

export class AdjustmentDecisionDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  approvedAmount?: number;

  @IsString()
  decisionReason: string;

  @IsOptional()
  @IsString()
  orderNumber?: string;

  @IsOptional()
  @IsString()
  orderDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(50)
  finePercent?: number;

  @IsOptional()
  @IsString()
  policyReference?: string;

  @IsOptional()
  explanationRefused?: boolean;

  @IsOptional()
  @IsString()
  refusalActReference?: string;
}

export class EmployeeExplanationDto {
  @IsString()
  explanation: string;
}

export class RequestAdvanceDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @Type(() => Number)
  @IsInt()
  @Min(2020)
  year: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class AdvanceDecisionDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  approvedAmount?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class MarkAdvancePaidDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  paidAmount: number;

  @IsString()
  paymentReference: string;
}
