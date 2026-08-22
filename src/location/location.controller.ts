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
        ? queryHospitalId
        : user.hospitalId;

    if (!targetHospitalId) {
      return [];
    }

    return this.locationService.getLatestLocations(targetHospitalId);
  }

  @Post('check-geofence')
  @Roles(UserRole.EMPLOYEE)
  async checkGeofence(
    @CurrentUser() user: { sub: string; hospitalId: string },
    @Body() dto: { latitude: number; longitude: number },
  ) {
    // Avval Position GPS, yo'q bo'lsa Hospital GPS
    const employee = await this.prisma.user.findUnique({
      where: { id: user.sub },
      include: {
        employee: {
          include: { position: true, hospital: true },
        },
      },
    });

    const position = employee?.employee?.position;
    const hospital = employee?.employee?.hospital;

    const geoLat = position?.gpsLat ?? hospital?.gpsLat ?? null;
    const geoLng = position?.gpsLng ?? hospital?.gpsLng ?? null;
    const geoRadius = position?.gpsRadius ?? hospital?.gpsRadius ?? 200;

    if (!geoLat || !geoLng) {
      return { inside: true, distance: 0, message: 'GPS sozlanmagan' };
    }

    const distance = this.locationService.getDistance(
      geoLat,
      geoLng,
      dto.latitude,
      dto.longitude,
    );

    const inside = distance <= geoRadius;

    return {
      inside,
      distance: Math.round(distance),
      radius: geoRadius,
    };
  }
}
