import { IsEmail } from 'class-validator';

export class UpdateEmailDto {
  @IsEmail({}, { message: "Email manzil noto'g'ri formatda" })
  email: string;
}
