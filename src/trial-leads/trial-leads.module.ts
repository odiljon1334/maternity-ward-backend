import { Module } from '@nestjs/common';
import { TrialLeadsController } from './trial-leads.controller';
import { TrialLeadsService } from './trial-leads.service';

@Module({
  controllers: [TrialLeadsController],
  providers: [TrialLeadsService],
  exports: [TrialLeadsService],
})
export class TrialLeadsModule {}
