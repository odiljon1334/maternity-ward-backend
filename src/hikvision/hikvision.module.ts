// hikvision.module.ts
import { Module } from '@nestjs/common';
import { HikvisionService } from './hikvision.service';
import { HikvisionController } from './hikvision.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HikvisionController],
  providers: [HikvisionService],
  exports: [HikvisionService],
})
export class HikvisionModule {}
