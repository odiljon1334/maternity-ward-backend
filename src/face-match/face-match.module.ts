import { Module } from '@nestjs/common';
import { FaceMatchService } from './face-match.service';
import { FaceMatchMonitorService } from './face-match-monitor.service';
import { SupportBotModule } from '../support-bot/support-bot.module';

@Module({
  imports: [SupportBotModule],
  providers: [FaceMatchService, FaceMatchMonitorService],
  exports: [FaceMatchService, FaceMatchMonitorService],
})
export class FaceMatchModule {}
