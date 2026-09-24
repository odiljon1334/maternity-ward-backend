import { Module } from '@nestjs/common';
import { WorkSitesController } from './work-sites.controller';
import { WorkSitesService } from './work-sites.service';
import { PlaceSearchService } from './place-search.service';

@Module({
  controllers: [WorkSitesController],
  providers: [WorkSitesService, PlaceSearchService],
  exports: [WorkSitesService],
})
export class WorkSitesModule {}
