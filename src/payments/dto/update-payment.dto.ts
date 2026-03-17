import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class UpdatePaymentDto {
  @IsNumber()
  @IsPositive()
  @IsOptional()
  amount?: number;

  @IsString()
  @IsOptional()
  note?: string;
}
