import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { TelegramAccessService } from './telegram-access.service';

@Module({
  controllers: [TelegramController],
  providers: [TelegramService, TelegramAccessService],
  exports: [TelegramService, TelegramAccessService],
})
export class TelegramModule {}
