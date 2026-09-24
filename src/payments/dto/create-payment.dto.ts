import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsPositive,
  Matches,
} from 'class-validator';
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

  /**
   * Qaysi oydan boshlab (YYYY-MM). Berilmasa — joriy oy. Yillik to'lov shu
   * oydan boshlab 12 oyni qoplaydi.
   */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: "Davr YYYY-MM ko'rinishida bo'lishi kerak",
  })
  period?: string;
}
