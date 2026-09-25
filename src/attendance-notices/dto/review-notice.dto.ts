import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewNoticeDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
