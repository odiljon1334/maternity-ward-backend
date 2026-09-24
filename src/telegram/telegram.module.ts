import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { TelegramAccessService } from './telegram-access.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramAccessService],
  exports: [TelegramService, TelegramAccessService],
})
export class TelegramModule {}
