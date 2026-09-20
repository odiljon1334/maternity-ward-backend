import { Module } from '@nestjs/common';
import { SupportBotService } from './support-bot.service';
import { SupportBotController } from './support-bot.controller';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [TelegramModule],
  controllers: [SupportBotController],
  providers: [SupportBotService],
})
export class SupportBotModule {}
