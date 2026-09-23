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
import { PushService } from '../push/push.service';
import { TelegramService } from '../telegram/telegram.service';
import { DateUtil } from '../common/utils/date.util';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

@Controller('location')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LocationController {
  constructor(
    private readonly locationService: LocationService,
    private readonly locationGateway: LocationGateway,
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
    private readonly telegramService: TelegramService,
  ) {}

  @Post('live')
  @Roles(UserRole.EMPLOYEE)
  async updateLiveLocation(
    @CurrentUser() user: { sub: string; hospitalId: string },
    @Body() dto: UpdateLiveLocationDto,
  ) {
    const userWithEmployee = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: {
        employee: {
          select: {
            id: true,
            fullName: true,
            photoUrl: true,
            hospitalId: true,
            gpsLat: true,
            gpsLng: true,
            gpsRadius: true,
            department: { select: { name: true } },
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
          },
        },
      },
    });

    const employee = userWithEmployee?.employee;
    if (!employee) return { ok: false };

    // ── 1. Ish vaqti tugagan/check-out qilingan bo'lsa — kuzatishni to'xtatish ──
    // Xodim check-out qilishni unutgan taqdirda ham GPS tracking abadiy davom
    // etmasligi kerak (production muammosi: xodim ketgach ham GPS saqlanaverar edi).
    const today = DateUtil.startOfDay(new Date());
    const attendance = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId: employee.id, workDate: today },
      select: {
        checkIn: true,
        checkOut: true,
        expectedCheckOut: true,
        status: true,
      },
    });

    const workEnded =
      !!attendance?.checkOut ||
      (!!attendance?.expectedCheckOut &&
        new Date() > attendance.expectedCheckOut);

    if (workEnded) {
      this.locationGateway.broadcastLocationRemoved(user.hospitalId, user.sub);
      return {
        ok: false,
        stopTracking: true,
        reason: attendance?.checkOut
          ? 'Check-out qilingan'
          : 'Ish vaqti tugagan',
      };
    }

    // ── 2. Geofence tekshiruvi ──
    const geoLat =
      employee.gpsLat ??
      employee.position?.gpsLat ??
      employee.hospital?.gpsLat ??
      null;
    const geoLng =
      employee.gpsLng ??
      employee.position?.gpsLng ??
      employee.hospital?.gpsLng ??
      null;
    const geoRadius =
      employee.gpsRadius ??
      employee.position?.gpsRadius ??
      employee.hospital?.gpsRadius ??
      200;

    let distance: number | null = null;
    let isOutside = false;
    if (geoLat != null && geoLng != null) {
      distance = Math.round(
        this.locationService.getDistance(
          geoLat,
          geoLng,
          dto.latitude,
          dto.longitude,
        ),
      );
      isOutside = distance > geoRadius;
    }

    // Yangi nuqta saqlanishidan OLDIN — oldingi nuqtani olib qo'yamiz
    // (ketma-ket 2 marta tashqarida bo'lsa — bu tasodifiy GPS sakrash emas).
    const previous = await this.locationService.getPreviousLocation(user.sub);

    const saved = await this.locationService.saveLiveLocation(
      user.sub,
      dto,
      isOutside,
    );

    if (isOutside && previous?.isOutside && distance != null) {
      this.pushService
        .notifyGeofenceViolation(
          user.hospitalId,
          employee.id,
          employee.fullName ?? 'Xodim',
          distance,
        )
        .then((sent) => {
          if (sent) {
            this.telegramService
              .notifyGeofenceAlert(
                { ...employee, hospitalId: user.hospitalId },
                distance,
                dto.latitude,
                dto.longitude,
              )
              .catch(() => {});
          }
        })
        .catch(() => {});
    }

    this.locationGateway.broadcastLocation(user.hospitalId, {
      userId: user.sub,
      name: employee.fullName,
      photo: employee.photoUrl,
      positionName: employee.position?.name ?? null,
      departmentName: employee.department?.name ?? null,
      hospitalName: employee.hospital?.name ?? null,
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
      speed: dto.speed,
      battery: dto.battery,
      distance,
      isOutside,
      checkIn: attendance?.checkIn ?? null,
      checkOut: attendance?.checkOut ?? null,
      attendanceStatus: attendance?.status ?? null,
      createdAt: saved.createdAt,
      // Eski mobil clientlar uchun rollout davrida saqlanadi.
      timestamp: saved.createdAt,
    });

    return { ok: true };
  }

  // Admin / Director — o'z hospitalidagi barcha locationlarni oladi
  @Get('live')
  @UseGuards(TenantScopeGuard)
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
      user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MINISTRY
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

    const geoLat =
      employee?.employee?.gpsLat ??
      position?.gpsLat ??
      hospital?.gpsLat ??
      null;

    const geoLng =
      employee?.employee?.gpsLng ??
      position?.gpsLng ??
      hospital?.gpsLng ??
      null;

    const geoRadius =
      employee?.employee?.gpsRadius ??
      position?.gpsRadius ??
      hospital?.gpsRadius ??
      200;

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
