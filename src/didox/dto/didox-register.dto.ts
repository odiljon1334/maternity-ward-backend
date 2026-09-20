import {
  IsBooleanString,
  IsEmail,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class DidoxRegisterDto {
  @IsString()
  @MinLength(4)
  serialNumber!: string;

  // E-IMZO ID lokal agenti tomonidan generatsiya qilingan pkcs7 imzo
  // (brauzerda accountant kompyuterida amalga oshiriladi — bizga faqat
  // tayyor imzolangan struktura keladi, xom kalit hech qachon kelmaydi)
  @IsString()
  @MinLength(10)
  pkcs7!: string;

  @IsEmail()
  email!: string;

  // +998XXXXXXXXX formatida
  @IsString()
  @Matches(/^\+998\d{9}$/, {
    message: "mobile +998XXXXXXXXX formatida bo'lishi kerak",
  })
  mobile!: string;

  @IsBooleanString()
  accept!: string;
}
