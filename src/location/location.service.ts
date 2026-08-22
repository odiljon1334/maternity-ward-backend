import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateLiveLocationDto } from './dto/update-live-location.dto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole, UserStatus } from '@prisma/client';

@Injectable()
export class LocationService {
  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanOldLocations() {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const deleted = await this.prisma.liveLocation.deleteMany({
      where: { createdAt: { lt: yesterday } },
    });
    console.log(`[LiveLocation] ${deleted.count} ta eski yozuv o'chirildi`);
  }

  getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  isInsideGeofence(
    hospitalLat: number,
    hospitalLng: number,
    radius: number,
    userLat: number,
    userLng: number,
  ): boolean {
    const distance = this.getDistance(
      hospitalLat,
      hospitalLng,
      userLat,
      userLng,
    );
    return distance <= radius;
  }

  async saveLiveLocation(userId: string, dto: UpdateLiveLocationDto) {
    return this.prisma.liveLocation.create({
      data: {
        userId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracy: dto.accuracy,
        speed: dto.speed,
        battery: dto.battery,
      },
    });
  }

  async getLatestLocations(hospitalId: string) {
    const employees = await this.prisma.user.findMany({
      where: {
        hospitalId,
        role: UserRole.EMPLOYEE,
        status: UserStatus.ACTIVE,
        employee: {
          isNot: null,
        },
        liveLocations: {
          some: {},
        },
      },

      select: {
        id: true,

        employee: {
          select: {
            fullName: true,
            photoUrl: true,

            attendances: {
              orderBy: {
                workDate: 'desc',
              },
              take: 1,
              select: {
                checkIn: true,
                checkOut: true,
                status: true,
              },
            },
          },
        },

        liveLocations: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
      },
    });

    return employees
      .filter(
        (u) => u.employee && u.employee.fullName && u.liveLocations.length > 0,
      )
      .map((u) => {
        const location = u.liveLocations[0];
        const attendance = u.employee?.attendances[0];

        return {
          userId: u.id,
          name: u.employee?.fullName ?? null,
          photo: u.employee?.photoUrl ?? null,

          checkIn: attendance?.checkIn ?? null,
          checkOut: attendance?.checkOut ?? null,
          attendanceStatus: attendance?.status ?? null,

          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy,
          speed: location.speed,
          battery: location.battery,
          timestamp: location.createdAt,
        };
      });
  }
}
