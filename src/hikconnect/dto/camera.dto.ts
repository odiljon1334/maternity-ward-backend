import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  Max,
  MinLength,
} from 'class-validator';

export class CreateCameraDto {
  @IsString()
  hospitalId: string;

  @IsString()
  @MinLength(1)
  name: string;

  /** MediaMTX stream path: "hospital1/cam1" */
  @IsOptional()
  @IsString()
  streamPath?: string;

  /** HikConnect camera index code (keyinroq) */
  @IsOptional()
  @IsString()
  cameraIndexCode?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  channelNo?: number;

  @IsOptional()
  @IsString()
  deviceSerial?: string;
}

export class UpdateCameraDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  streamPath?: string;

  @IsOptional()
  @IsString()
  cameraIndexCode?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  channelNo?: number;

  @IsOptional()
  @IsString()
  deviceSerial?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
