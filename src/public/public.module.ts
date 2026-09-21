import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { SupportBotModule } from '../support-bot/support-bot.module';
import { TrialLeadsModule } from '../trial-leads/trial-leads.module';

@Module({
  imports: [SupportBotModule, TrialLeadsModule],
  controllers: [PublicController],
})
export class PublicModule {}
