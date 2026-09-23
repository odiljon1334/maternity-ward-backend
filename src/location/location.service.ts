import { buildGeoCenters, matchGeoCenter } from '../work-sites/geofence.util';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateLiveLocationDto } from './dto/update-live-location.dto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole, UserStatus } from '@prisma/client';

const DEFAULT_LIVE_LOCATION_STALE_MINUTES = 10;

export type LiveTrackingStatus = 'ONLINE' | 'OUTSIDE' | 'SIGNAL_LOST';

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

  async saveLiveLocation(
    userId: string,
    dto: UpdateLiveLocationDto,
    isOutside?: boolean,
  ) {
    return this.prisma.liveLocation.create({
      data: {
        userId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracy: dto.accuracy,
        speed: dto.speed,
        battery: dto.battery,
        isOutside: isOutside ?? null,
      },
    });
  }

  /** Shu foydalanuvchining oxirgi (yangisidan oldingi) GPS nuqtasi — ketma-ket
   *  "geofence tashqarisida" holatini aniqlash uchun ishlatiladi. */
  async getPreviousLocation(userId: string) {
    return this.prisma.liveLocation.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getLatestLocations(hospitalId: string) {
    const employees = await this.prisma.user.findMany({
      where: {
        hospitalId,
        role: UserRole.EMPLOYEE,
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        employee: {
          select: {
            fullName: true,
            photoUrl: true,
            gpsLat: true,
            gpsLng: true,
            gpsRadius: true,
            department: {
              select: { name: true },
            },
            position: {
              select: {
                name: true,
                gpsLat: true,
                gpsLng: true,
                gpsRadius: true,
              },
            },
            hospital: {
              select: {
                name: true,
                gpsLat: true,
                gpsLng: true,
                gpsRadius: true,
              },
            },
            workSites: { select: { workSite: true } },
            attendances: {
              where: {
                workDate: {
                  gte: new Date(new Date().setHours(0, 0, 0, 0)),
                },
              },
              orderBy: { workDate: 'desc' },
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
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return employees
      .filter((u) => {
        if (u.liveLocations.length === 0) return false;
        // Faqat hozir smenada bo'lgan xodimlar (check-in qilgan, check-out qilmagan)
        // "live" sifatida ko'rsatiladi — aks holda check-out qilingandan keyin ham
        // eski GPS nuqtasi live xaritada qolib ketaveradi
        const today = u.employee?.attendances?.[0];
        return !!today?.checkIn && !today?.checkOut;
      })
      .map((u) => {
        const loc = u.liveLocations[0];
        const configuredStaleMinutes = Number(
          process.env.LIVE_LOCATION_STALE_MINUTES ??
            DEFAULT_LIVE_LOCATION_STALE_MINUTES,
        );
        const staleMinutes = Number.isFinite(configuredStaleMinutes)
          ? Math.min(60, Math.max(3, configuredStaleMinutes))
          : DEFAULT_LIVE_LOCATION_STALE_MINUTES;
        const isStale =
          Date.now() - loc.createdAt.getTime() > staleMinutes * 60_000;
        const trackingStatus: LiveTrackingStatus = isStale
          ? 'SIGNAL_LOST'
          : loc.isOutside
            ? 'OUTSIDE'
            : 'ONLINE';
        // Eng yaqin ruxsat etilgan ish joyigacha masofa (FAZA 6, 4b)
        const match = u.employee
          ? matchGeoCenter(
              buildGeoCenters({
                employee: u.employee,
                position: u.employee.position,
                hospital: u.employee.hospital,
                sites: (u.employee.workSites ?? []).map((w) => w.workSite),
              }),
              loc.latitude,
              loc.longitude,
            )
          : null;
        const distance: number | null = match
          ? Math.round(match.distance)
          : null;

        return {
          userId: u.id,
          name: u.employee?.fullName,
          photo: u.employee?.photoUrl,
          positionName: u.employee?.position?.name ?? null,
          departmentName: u.employee?.department?.name ?? null,
          hospitalName: u.employee?.hospital?.name ?? null,
          distance,
          checkIn: u.employee?.attendances?.[0]?.checkIn ?? null,
          checkOut: u.employee?.attendances?.[0]?.checkOut ?? null,
          attendanceStatus: u.employee?.attendances?.[0]?.status ?? null,
          isStale,
          trackingStatus,
          staleAfterMinutes: staleMinutes,
          ...loc,
        };
      });
  }
}
