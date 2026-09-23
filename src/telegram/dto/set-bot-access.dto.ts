import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class SetBotAccessDto {
  @IsBoolean()
  enabled!: boolean;

  /** Faqat SUPER_ADMIN uchun — qaysi muassasa (boshqa rollarda JWT'dan olinadi). */
  @IsOptional()
  @IsString()
  hospitalId?: string;
}
