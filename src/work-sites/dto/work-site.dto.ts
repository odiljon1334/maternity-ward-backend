import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const ACCURACY_MESSAGE =
  "Joylashuv aniqligi yetarli emas (±75m dan yaxshi bo'lishi kerak). Ochiq joyga chiqib qayta urinib ko'ring yoki nuqtani xaritadan tanlang.";

export class CreateWorkSiteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  radius?: number;

  /** "Hozirgi joyim" orqali olinganda — brauzer bergan aniqlik (metr) */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(75, { message: ACCURACY_MESSAGE })
  accuracy?: number;
}

export class UpdateWorkSiteDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  radius?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(75, { message: ACCURACY_MESSAGE })
  accuracy?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetWorkSiteEmployeesDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  employeeIds!: string[];
}

export class SetEmployeeWorkSitesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  workSiteIds!: string[];
}

export class ApproveLegacyCenterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  radius?: number;
}
