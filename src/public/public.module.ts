import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [TelegramModule],
  controllers: [PublicController],
})
export class PublicModule {}
