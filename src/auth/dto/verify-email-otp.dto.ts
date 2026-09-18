import { IsString, Length } from 'class-validator';

export class VerifyEmailOtpDto {
  @IsString()
  @Length(6, 6, { message: 'Kod 6 xonali bo\'lishi kerak' })
  code: string;
}
