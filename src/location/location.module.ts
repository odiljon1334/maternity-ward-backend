import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { LocationGateway } from './location.gateway';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
    }),
  ],
  controllers: [LocationController],
  providers: [LocationService, LocationGateway],
  exports: [LocationService, LocationGateway],
})
export class LocationModule {}
