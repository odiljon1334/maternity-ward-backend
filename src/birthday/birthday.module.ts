import { Module } from '@nestjs/common';
import { BirthdayService } from './birthday.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, TelegramModule],
  providers: [BirthdayService],
})
export class BirthdayModule {}