import { IsString, MinLength } from 'class-validator';

export class DidoxChallengeDto {
  // ЭЦП kalitining seriya raqami (o'n oltilik format)
  @IsString()
  @MinLength(4)
  serialNumber!: string;
}
