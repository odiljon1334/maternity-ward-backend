import { Module } from '@nestjs/common';
import { SupportBotService } from './support-bot.service';
import { SupportBotController } from './support-bot.controller';
import { TelegramModule } from '../telegram/telegram.module';
import { ContractModule } from '../contract/contract.module';

@Module({
  imports: [TelegramModule, ContractModule],
  controllers: [SupportBotController],
  providers: [SupportBotService],
  exports: [SupportBotService],
})
export class SupportBotModule {}
