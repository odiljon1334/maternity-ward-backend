import { IsBoolean, IsNumber, IsOptional, Min, Max } from 'class-validator';

export class UpdateLiveLocationDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsNumber()
  accuracy: number;

  @IsOptional()
  @IsNumber()
  speed?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  battery?: number;

  /** Android: nuqta soxta provayderdan (Fake GPS ilovasi) kelgan */
  @IsOptional()
  @IsBoolean()
  mocked?: boolean;
}
