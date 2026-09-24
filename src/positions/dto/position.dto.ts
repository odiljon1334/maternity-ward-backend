import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Klass DTO — global `whitelist` ortiqcha maydonlarni (hospitalId, id) olib tashlaydi */
export class PositionNameDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
}

export class UpdatePositionGpsDto {
  @ValidateIf((o) => o.gpsLat !== null && o.gpsLat !== undefined)
  @IsNumber()
  @Min(-90)
  @Max(90)
  gpsLat?: number | null;

  @ValidateIf((o) => o.gpsLng !== null && o.gpsLng !== undefined)
  @IsNumber()
  @Min(-180)
  @Max(180)
  gpsLng?: number | null;

  @ValidateIf((o) => o.gpsRadius !== null && o.gpsRadius !== undefined)
  @IsNumber()
  @Min(10)
  @Max(50000)
  gpsRadius?: number | null;
}
