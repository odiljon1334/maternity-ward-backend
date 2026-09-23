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

  /**
   * Joriy ochiq davomat yozuvini workDate bilan cheklamaymiz: 20:00–08:00
   * tungi smena yarim tundan keyin ham avvalgi kun yozuvi bilan davom etadi.
   */
  private findOpenAttendance(employeeId: string) {
    return this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        checkIn: { not: null },
        checkOut: null,
      },
      orderBy: { checkIn: 'desc' },
      select: {
        checkIn: true,
        checkOut: true,
        expectedCheckOut: true,
        status: true,
      },
    });
  }

  @Get('tracking-session')
  @Roles(UserRole.EMPLOYEE)
  async getTrackingSession(@CurrentUser() user: { sub: string }) {
    const account = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { employee: { select: { id: true } } },
    });

    if (!account?.employee) {
      return { active: false, reason: 'EMPLOYEE_NOT_FOUND' };
    }

    const attendance = await this.findOpenAttendance(account.employee.id);
    const expectedCheckOut = attendance?.expectedCheckOut ?? null;
    const active =
      !!attendance?.checkIn &&
      !!expectedCheckOut &&
      expectedCheckOut.getTime() > Date.now();

    return {
      active,
      checkIn: attendance?.checkIn ?? null,
      expectedCheckOut,
      reason: active
        ? null
        : attendance?.checkIn
          ? 'SHIFT_ENDED'
          : 'NOT_CHECKED_IN',
      heartbeatMs: 3 * 60 * 1000,
    };
  }

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
    const attendance = await this.findOpenAttendance(employee.id);

    const workEnded =
      !attendance?.checkIn ||
      !!attendance?.checkOut ||
      !attendance.expectedCheckOut ||
      (!!attendance?.expectedCheckOut &&
        new Date() > attendance.expectedCheckOut);

    if (workEnded) {
      this.locationGateway.broadcastLocationRemoved(user.hospitalId, user.sub);
      return {
        ok: false,
        stopTracking: true,
        reason: attendance?.checkOut
          ? 'Check-out qilingan'
          : attendance?.checkIn
            ? 'Ish vaqti tugagan'
            : 'Faol check-in topilmadi',
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
      // GPS bergan `accuracy` — haqiqiy nuqta shu radius ichida bo'lishi
      // ehtimoli borligini bildiradi. Aniqlik past paytda xodimni noto'g'ri
      // ravishda tashqarida deb belgilamaslik uchun butun noaniqlik doirasi
      // geofence'dan tashqariga chiqqandagina violation hisoblaymiz.
      const uncertainty = Number.isFinite(dto.accuracy)
        ? Math.max(0, dto.accuracy)
        : 0;
      isOutside = distance > geoRadius + uncertainty;
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
      isStale: false,
      trackingStatus: isOutside ? 'OUTSIDE' : 'ONLINE',
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
