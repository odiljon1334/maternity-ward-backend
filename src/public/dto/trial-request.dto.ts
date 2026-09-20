import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const ORG_TYPES = ['clinic', 'factory', 'office', 'retail', 'edu'] as const;
const PLANS = ['start', 'biznes', 'korporativ'] as const;
const BILLING_CYCLES = ['monthly', 'annual'] as const;

export class TrialRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  hospitalName: string;

  @IsOptional()
  @IsIn(ORG_TYPES)
  orgType?: (typeof ORG_TYPES)[number];

  @IsString()
  @MinLength(2)
  @MaxLength(150)
  directorName: string;

  @IsString()
  @MinLength(9)
  @MaxLength(30)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20000)
  staffCount?: number;

  @IsOptional()
  @IsIn(PLANS)
  plan?: (typeof PLANS)[number];

  @IsOptional()
  @IsIn(BILLING_CYCLES)
  billingCycle?: (typeof BILLING_CYCLES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmCampaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  pageUrl?: string;
}
