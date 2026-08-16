import { Module } from '@nestjs/common';
import { HikConnectService } from './hikconnect.service';
import { HikConnectController } from './hikconnect.controller';
import { AudioGateway } from './audio.gateway';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HikConnectController],
  providers: [HikConnectService, AudioGateway],
  exports: [HikConnectService],
})
export class HikConnectModule {}
