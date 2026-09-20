import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { SupportBotModule } from '../support-bot/support-bot.module';

@Module({
  imports: [SupportBotModule],
  controllers: [PublicController],
})
export class PublicModule {}
