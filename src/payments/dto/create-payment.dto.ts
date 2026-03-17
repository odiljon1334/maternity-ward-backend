import { IsString, IsNumber, IsEnum, IsOptional, IsPositive } from 'class-validator';
import { PaymentType } from '@prisma/client';

export class CreatePaymentDto {
  @IsString()
  hospitalId: string;

  @IsString()
  payerName: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsEnum(PaymentType)
  type: PaymentType;

  @IsString()
  @IsOptional()
  note?: string;
}
