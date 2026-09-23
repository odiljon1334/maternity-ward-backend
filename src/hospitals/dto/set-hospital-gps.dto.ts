import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Muassasa geofence markazi — faqat DIRECTOR/ADMIN o'z muassasasi uchun. */
export class SetHospitalGpsDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  /** "Hozirgi joyimni markaz qilish"da brauzer bergan aniqlik (metr). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(75, {
    message:
      "Joylashuv aniqligi yetarli emas (±75m dan yaxshi bo'lishi kerak). Ochiq joyga chiqib qayta urinib ko'ring.",
  })
  accuracy?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  radius?: number;
}
