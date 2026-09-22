import { Module } from '@nestjs/common';
import { SchedulePlanningController } from './schedule-planning.controller';
import { SchedulePlanningService } from './schedule-planning.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [SchedulePlanningController],
  providers: [SchedulePlanningService],
  exports: [SchedulePlanningService],
})
export class SchedulePlanningModule {}
