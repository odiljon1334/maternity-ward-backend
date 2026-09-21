import { Module } from '@nestjs/common';
import { SupportBotService } from './support-bot.service';
import { SupportBotController } from './support-bot.controller';
import { TelegramModule } from '../telegram/telegram.module';
import { ContractModule } from '../contract/contract.module';
import { TrialLeadsModule } from '../trial-leads/trial-leads.module';

@Module({
  imports: [TelegramModule, ContractModule, TrialLeadsModule],
  controllers: [SupportBotController],
  providers: [SupportBotService],
  exports: [SupportBotService],
})
export class SupportBotModule {}
