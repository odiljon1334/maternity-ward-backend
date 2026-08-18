// src/hikvision/hikvision.dto.ts
import { IsString, IsOptional } from 'class-validator';

export class AddPersonDto {
  @IsString()
  employeeNo: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  beginTime?: string;

  @IsOptional()
  @IsString()
  endTime?: string;
}
