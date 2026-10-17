import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class PreviewOpenShiftDto {
  @IsUUID()
  departmentId: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Sana YYYY-MM-DD formatida' })
  date: string;

  @IsUUID()
  shiftId: string;

  @IsOptional()
  @IsUUID()
  absentEmployeeId?: string;
}

export class CreateOpenShiftDto extends PreviewOpenShiftDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Kamida bitta xodimni tanlang' })
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  employeeIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ReviewOpenShiftDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
