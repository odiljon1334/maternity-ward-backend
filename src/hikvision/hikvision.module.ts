// hikvision.module.ts
import { HikSyncQueueService } from './hik-sync-queue.service';
import { Module } from '@nestjs/common';
import { HikvisionService } from './hikvision.service';
import { HikvisionController } from './hikvision.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HikvisionController],
  providers: [HikvisionService, HikSyncQueueService],
  exports: [HikvisionService],
})
export class HikvisionModule {}
