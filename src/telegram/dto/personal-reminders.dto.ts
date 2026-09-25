import { IsBoolean } from 'class-validator';

export class PersonalRemindersDto {
  @IsBoolean()
  enabled: boolean;
}
