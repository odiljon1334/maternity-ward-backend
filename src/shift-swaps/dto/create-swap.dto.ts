import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateSwapDto {
  @IsIn(['SWAP', 'COVER'])
  type: 'SWAP' | 'COVER';

  /** Mening smenam kuni, "YYYY-MM-DD" */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  requesterDate: string;

  @IsUUID()
  targetId: string;

  /** SWAP: hamkasbning men oladigan kuni (bo'lmasa — o'sha kun, boshqa smena) */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  targetDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
