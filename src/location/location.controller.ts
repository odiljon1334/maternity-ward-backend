import { Controller, Post, Get, Body, UseGuards, Query } from '@nestjs/common';
import { LocationService } from './location.service';
import { LocationGateway } from './location.gateway';
import { UpdateLiveLocationDto } from './dto/update-live-location.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Controller('location')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LocationController {
  constructor(
    private readonly locationService: LocationService,
    private readonly locationGateway: LocationGateway,
    private readonly prisma: PrismaService,
  ) {}

  // EMPLOYEE — o'z locationini yuboradi
  @Post('live')
  @Roles(UserRole.EMPLOYEE)
  async updateLiveLocation(
    @CurrentUser() user: { sub: string; hospitalId: string },
    @Body() dto: UpdateLiveLocationDto,
  ) {
    const saved = await this.locationService.saveLiveLocation(user.sub, dto);

    const employee = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: {
        employee: {
          select: {
            fullName: true,
            photoUrl: true,
          },
        },
      },
    });

    this.locationGateway.broadcastLocation(user.hospitalId, {
      userId: user.sub,
      name: employee?.employee?.fullName,
      photo: employee?.employee?.photoUrl,
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
      speed: dto.speed,
      battery: dto.battery,
      timestamp: saved.createdAt,
    });

    return { ok: true };
  }

  // Admin / Director — o'z hospitalidagi barcha locationlarni oladi
  @Get('live')
  @Roles(
    UserRole.DIRECTOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.DEPARTMENT_HEAD,
    UserRole.ASSISTANT_ADMIN,
    UserRole.MINISTRY,
  )
  async getLiveLocations(
    @CurrentUser() user: { sub: string; hospitalId: string; role: UserRole },
    @Query('hospitalId') queryHospitalId?: string,
  ) {
    // SUPER_ADMIN hospitalId ni query dan oladi
    const targetHospitalId =
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.MINISTRY ||
      user.role === UserRole.ASSISTANT_ADMIN
        ? queryHospitalId // ← query param majburiy
        : user.hospitalId;

    if (!targetHospitalId) {
      return [];
    }

    return this.locationService.getLatestLocations(targetHospitalId);
  }

  // Geofence tekshirish (check-in paytida mobile chaqiradi)
  @Post('check-geofence')
  @Roles(UserRole.EMPLOYEE)
  async checkGeofence(
    @CurrentUser() user: { sub: string; hospitalId: string },
    @Body() dto: { latitude: number; longitude: number },
  ) {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: user.hospitalId },
      select: { gpsLat: true, gpsLng: true, gpsRadius: true },
    });

    if (!hospital?.gpsLat || !hospital?.gpsLng) {
      return { inside: true, distance: 0, message: 'GPS sozlanmagan' };
    }

    const distance = this.locationService.getDistance(
      hospital.gpsLat,
      hospital.gpsLng,
      dto.latitude,
      dto.longitude,
    );

    const inside = distance <= (hospital.gpsRadius ?? 200);

    return {
      inside,
      distance: Math.round(distance),
      radius: hospital.gpsRadius ?? 200,
    };
  }
}
