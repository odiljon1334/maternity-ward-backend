import { IsString, Length, MinLength } from 'class-validator';

/** Telegram/SMS orqali kelgan parolni tiklash OTP kodini tasdiqlash uchun */
export class VerifyResetOtpDto {
  @IsString()
  username: string;

  @IsString()
  @Length(6, 6, { message: "Kod 6 xonali bo'lishi kerak" })
  code: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}
