import { Module } from '@nestjs/common';
import { FaceMatchService } from './face-match.service';
import { FaceMatchMonitorService } from './face-match-monitor.service';
import { SupportBotModule } from '../support-bot/support-bot.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FaceRecheckService } from './face-recheck.service';

@Module({
  imports: [SupportBotModule, NotificationsModule],
  providers: [FaceMatchService, FaceMatchMonitorService, FaceRecheckService],
  exports: [FaceMatchService, FaceMatchMonitorService, FaceRecheckService],
})
export class FaceMatchModule {}
