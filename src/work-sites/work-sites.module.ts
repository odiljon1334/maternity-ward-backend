import { Module } from '@nestjs/common';
import { WorkSitesController } from './work-sites.controller';
import { WorkSitesService } from './work-sites.service';

@Module({
  controllers: [WorkSitesController],
  providers: [WorkSitesService],
  exports: [WorkSitesService],
})
export class WorkSitesModule {}
