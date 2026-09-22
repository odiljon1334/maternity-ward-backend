import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreateSchedulePostDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @MinLength(1)
  code: string;

  @IsString()
  departmentId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  dailyCoverageMinutes?: number;
}
