import { Module } from '@nestjs/common';
import { SchedulePlanningController } from './schedule-planning.controller';
import { SchedulePlanningService } from './schedule-planning.service';

@Module({
  controllers: [SchedulePlanningController],
  providers: [SchedulePlanningService],
  exports: [SchedulePlanningService],
})
export class SchedulePlanningModule {}
