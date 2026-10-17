import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { OpenShiftsController } from './open-shifts.controller';
import { OpenShiftsService } from './open-shifts.service';

@Module({
  imports: [PrismaModule, TelegramModule],
  controllers: [OpenShiftsController],
  providers: [OpenShiftsService],
  exports: [OpenShiftsService],
})
export class OpenShiftsModule {}
