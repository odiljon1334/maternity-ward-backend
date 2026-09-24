import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, SubscriptionBillingService],
  exports: [PaymentsService, SubscriptionBillingService],
})
export class PaymentsModule {}
