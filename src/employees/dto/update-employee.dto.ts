import { PartialType } from '@nestjs/mapped-types';
import { CreateEmployeeDto } from './create-employee.dto';
import { IsDateString, IsOptional, IsString } from 'class-validator';

export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;
}

export class FireEmployeeDto {
  firedAt?: string;
  fireReason?: string; // RESIGNED | FIRED | RETIRED | TRANSFERRED | OTHER
  fireNote?: string;
}
