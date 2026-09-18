import { Module } from '@nestjs/common';
import { FaceMatchService } from './face-match.service';

@Module({
  providers: [FaceMatchService],
  exports: [FaceMatchService],
})
export class FaceMatchModule {}
