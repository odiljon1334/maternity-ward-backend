import { Module } from '@nestjs/common';
import { HikConnectService } from './hikconnect.service';
import { HikConnectController } from './hikconnect.controller';
import { LiveAccessController } from './live-access.controller';
import { AudioGateway } from './audio.gateway';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HikConnectController, LiveAccessController],
  providers: [HikConnectService, AudioGateway],
  exports: [HikConnectService],
})
export class HikConnectModule {}
