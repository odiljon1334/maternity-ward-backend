import { Module } from '@nestjs/common';
import { DidoxService } from './didox.service';
import { DidoxController } from './didox.controller';

@Module({
  controllers: [DidoxController],
  providers: [DidoxService],
  exports: [DidoxService],
})
export class DidoxModule {}
