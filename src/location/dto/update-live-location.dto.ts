import {
  IsBoolean,
  IsISO8601,
  IsNumber,
  IsOptional,
  Min,
  Max,
} from 'class-validator';

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

  /** Qurilma GPS nuqtasini olgan vaqt; qisqa offline navbatni xavfsiz yuborish uchun */
  @IsOptional()
  @IsISO8601({ strict: true })
  capturedAt?: string;
}
