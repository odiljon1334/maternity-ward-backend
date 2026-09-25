import { buildGeoCenters, matchGeoCenter } from '../work-sites/geofence.util';
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
            workSites: { select: { workSite: true } },
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

    // ── 1b. Soxta joylashuv (Fake GPS) ──
    // Nuqta saqlanmaydi va xaritada ko'rsatilmaydi: rahbariyat xodimni
    // "signal yo'q" holatida ko'radi, ketishda esa yuz tekshiruvi talab
    // qilinadi (kuzatuv uzilgan). Kuzatuv to'xtatilmaydi — soxta ilova
    // o'chirilishi bilan haqiqiy nuqtalar yana qabul qilinadi.
    if (dto.mocked === true) {
      this.locationGateway.broadcastLocationRemoved(user.hospitalId, user.sub);
      this.pushService
        .notifyMockLocation(
          user.hospitalId,
          employee.id,
          employee.fullName ?? 'Xodim',
          'TRACKING',
        )
        .then((sent) => {
          if (sent) {
            this.telegramService
              .notifyMockLocation(
                { ...employee, hospitalId: user.hospitalId },
                'TRACKING',
              )
              .catch(() => {});
          }
        })
        .catch(() => {});
      return { ok: false, reason: 'MOCK_LOCATION' };
    }

    // ── 2. Geofence tekshiruvi ──
    // FAZA 6 (4b): xodimga ruxsat etilgan BARCHA ish joylari hisobga olinadi
    // (biriktirilgan WorkSite'lar + asosiy bino). Maktabga yo'naltirilgan
    // hamshira asosiy binodan uzoqda bo'lgani uchun "tashqarida" sanalmaydi.
    //
    // GPS bergan `accuracy` — haqiqiy nuqta shu radius ichida bo'lishi
    // ehtimoli borligini bildiradi. Aniqlik past paytda xodimni noto'g'ri
    // ravishda tashqarida deb belgilamaslik uchun butun noaniqlik doirasi
    // geofence'dan tashqariga chiqqandagina violation hisoblaymiz.
    const uncertainty = Number.isFinite(dto.accuracy)
      ? Math.max(0, dto.accuracy)
      : 0;
    const geoMatch = matchGeoCenter(
      buildGeoCenters({
        employee,
        position: employee.position,
        hospital: employee.hospital,
        sites: (employee.workSites ?? []).map((w) => w.workSite),
      }),
      dto.latitude,
      dto.longitude,
      uncertainty,
    );
    const distance: number | null = geoMatch
      ? Math.round(geoMatch.distance)
      : null;
    const isOutside = geoMatch ? !geoMatch.inside : false;

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
    const user_ = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: {
        employee: {
          select: {
            gpsLat: true,
            gpsLng: true,
            gpsRadius: true,
            position: {
              select: { gpsLat: true, gpsLng: true, gpsRadius: true },
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
          },
        },
      },
    });
    const employee = user_?.employee;
    const match = employee
      ? matchGeoCenter(
          buildGeoCenters({
            employee,
            position: employee.position,
            hospital: employee.hospital,
            sites: (employee.workSites ?? []).map((w) => w.workSite),
          }),
          dto.latitude,
          dto.longitude,
        )
      : null;

    if (!match) {
      return { inside: true, distance: 0, message: 'GPS sozlanmagan' };
    }

    return {
      inside: match.inside,
      distance: Math.round(match.distance),
      radius: match.center.radius,
      siteName: match.center.name,
    };
  }
}
