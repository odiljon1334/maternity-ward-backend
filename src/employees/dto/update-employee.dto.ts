import { PartialType } from '@nestjs/mapped-types';
import { CreateEmployeeDto } from './create-employee.dto';
import { IsOptional, IsString } from 'class-validator';

export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;
}

export class FireEmployeeDto {
  firedAt?:    string;
  fireReason?: string; // RESIGNED | FIRED | RETIRED | TRANSFERRED | OTHER
  fireNote?:   string;
}
