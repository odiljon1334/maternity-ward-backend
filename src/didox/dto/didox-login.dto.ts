import { IsString, MinLength } from 'class-validator';

export class DidoxLoginDto {
  @IsString()
  @MinLength(4)
  serialNumber!: string;

  // /didox/challenge chaqiruvidan olingan authId
  @IsString()
  @MinLength(4)
  authId!: string;

  // E-IMZO ID agenti tomonidan { authId } JSON'ini imzolab bergan pkcs7
  @IsString()
  @MinLength(10)
  pkcs7!: string;
}
