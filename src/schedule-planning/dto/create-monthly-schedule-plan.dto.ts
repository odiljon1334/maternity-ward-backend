import { IsInt, IsString, Max, Min } from 'class-validator';

export class CreateMonthlySchedulePlanDto {
  @IsString()
  postId: string;

  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2000)
  @Max(2200)
  year: number;
}
