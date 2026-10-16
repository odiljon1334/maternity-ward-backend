import { Module } from '@nestjs/common';
import { SchedulePlanningModule } from '../schedule-planning/schedule-planning.module';
import { OperationalCenterController } from './operational-center.controller';
import { OperationalCenterService } from './operational-center.service';

@Module({
  imports: [SchedulePlanningModule],
  controllers: [OperationalCenterController],
  providers: [OperationalCenterService],
})
export class OperationalCenterModule {}
