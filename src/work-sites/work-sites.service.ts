import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { haversineMeters } from '../common/utils/geo.util';
import {
  ApproveLegacyCenterDto,
  CreateWorkSiteDto,
  UpdateWorkSiteDto,
} from './dto/work-site.dto';
import { buildGeoCenters } from './geofence.util';

/**
 * Ish joylari (WorkSite) boshqaruvi — FAZA 6, 4b.
 * Har bir metod `hospitalId`ni controller'dan (JWT / tasdiqlangan tenant)
 * oladi va barcha so'rovlar shu muassasa bilan cheklanadi.
 */
@Injectable()
export class WorkSitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(hospitalId: string) {
    const sites = await this.prisma.workSite.findMany({
      where: { hospitalId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { employees: { where: { employee: { firedAt: null } } } },
        },
      },
    });
    return sites.map(({ _count, ...site }) => ({
      ...site,
      employeeCount: _count.employees,
    }));
  }

  async create(hospitalId: string, dto: CreateWorkSiteDto) {
    return this.prisma.workSite.create({
      data: {
        hospitalId,
        name: dto.name.trim(),
        address: dto.address?.trim() || null,
        gpsLat: dto.lat,
        gpsLng: dto.lng,
        ...(dto.radius != null && { gpsRadius: dto.radius }),
      },
    });
  }

  async update(hospitalId: string, id: string, dto: UpdateWorkSiteDto) {
    await this.findOwned(hospitalId, id);
    if ((dto.lat == null) !== (dto.lng == null)) {
      throw new BadRequestException(
        'Kenglik va uzunlik birga yuborilishi kerak',
      );
    }
    return this.prisma.workSite.update({
      where: { id },
      data: {
        ...(dto.name != null && { name: dto.name.trim() }),
        ...(dto.address !== undefined && {
          address: dto.address?.trim() || null,
        }),
        ...(dto.lat != null && { gpsLat: dto.lat, gpsLng: dto.lng }),
        ...(dto.radius != null && { gpsRadius: dto.radius }),
        ...(dto.isActive != null && { isActive: dto.isActive }),
      },
    });
  }

  async remove(hospitalId: string, id: string) {
    await this.findOwned(hospitalId, id);
    // Davomat yozuvlaridagi havola SET NULL bo'ladi, biriktirishlar o'chadi
    await this.prisma.workSite.delete({ where: { id } });
    return { deleted: true };
  }

  async listEmployees(hospitalId: string, id: string) {
    await this.findOwned(hospitalId, id);
    const rows = await this.prisma.employeeWorkSite.findMany({
      where: { workSiteId: id, employee: { firedAt: null } },
      select: {
        employee: {
          select: {
            id: true,
            fullName: true,
            position: { select: { name: true } },
          },
        },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
    return rows.map((r) => ({
      id: r.employee.id,
      fullName: r.employee.fullName,
      position: r.employee.position?.name ?? null,
    }));
  }

  /** Ish joyiga biriktirilgan xodimlar ro'yxatini to'liq almashtiradi. */
  async setEmployees(hospitalId: string, id: string, employeeIds: string[]) {
    await this.findOwned(hospitalId, id);
    const unique = [...new Set(employeeIds)];

    if (unique.length) {
      const valid = await this.prisma.employee.count({
        where: { id: { in: unique }, hospitalId, firedAt: null },
      });
      if (valid !== unique.length) {
        throw new BadRequestException(
          "Ro'yxatda bu muassasaga tegishli bo'lmagan yoki ishdan bo'shagan xodim bor",
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.employeeWorkSite.deleteMany({
        where: { workSiteId: id, employeeId: { notIn: unique } },
      }),
      this.prisma.employeeWorkSite.createMany({
        data: unique.map((employeeId) => ({ employeeId, workSiteId: id })),
        skipDuplicates: true,
      }),
    ]);
    return { workSiteId: id, employeeCount: unique.length };
  }

  /**
   * Xodimlar o'zlari (eski, 2026-09-23 gacha bo'lgan oqimda) qo'ygan
   * shaxsiy markazlar — admin ko'rib chiqishi uchun.
   */
  async listLegacyCenters(hospitalId: string) {
    const [hospital, employees] = await Promise.all([
      this.prisma.hospital.findUnique({
        where: { id: hospitalId },
        select: { gpsLat: true, gpsLng: true },
      }),
      this.prisma.employee.findMany({
        where: { hospitalId, firedAt: null, gpsLat: { not: null } },
        select: {
          id: true,
          fullName: true,
          gpsLat: true,
          gpsLng: true,
          gpsRadius: true,
          position: { select: { name: true } },
          department: { select: { name: true } },
        },
        orderBy: { fullName: 'asc' },
      }),
    ]);

    return employees
      .filter((e) => e.gpsLat != null && e.gpsLng != null)
      .map((e) => ({
        employeeId: e.id,
        fullName: e.fullName,
        position: e.position?.name ?? null,
        department: e.department?.name ?? null,
        gpsLat: e.gpsLat as number,
        gpsLng: e.gpsLng as number,
        gpsRadius: e.gpsRadius ?? 100,
        distanceFromMain:
          hospital?.gpsLat != null && hospital?.gpsLng != null
            ? Math.round(
                haversineMeters(
                  e.gpsLat as number,
                  e.gpsLng as number,
                  hospital.gpsLat,
                  hospital.gpsLng,
                ),
              )
            : null,
      }));
  }

  /** Shaxsiy markazni ish joyiga aylantiradi va xodimni unga biriktiradi. */
  async approveLegacyCenter(
    hospitalId: string,
    employeeId: string,
    dto: ApproveLegacyCenterDto,
  ) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, hospitalId, firedAt: null },
      select: { id: true, gpsLat: true, gpsLng: true, gpsRadius: true },
    });
    if (!employee || employee.gpsLat == null || employee.gpsLng == null) {
      throw new NotFoundException('Tasdiqlanmagan shaxsiy markaz topilmadi');
    }

    return this.prisma.$transaction(async (tx) => {
      const site = await tx.workSite.create({
        data: {
          hospitalId,
          name: dto.name.trim(),
          gpsLat: employee.gpsLat as number,
          gpsLng: employee.gpsLng as number,
          gpsRadius: dto.radius ?? Math.max(100, employee.gpsRadius ?? 100),
        },
      });
      await tx.employeeWorkSite.create({
        data: { employeeId: employee.id, workSiteId: site.id },
      });
      await tx.employee.update({
        where: { id: employee.id },
        data: { gpsLat: null, gpsLng: null },
      });
      return site;
    });
  }

  async rejectLegacyCenter(hospitalId: string, employeeId: string) {
    const result = await this.prisma.employee.updateMany({
      where: { id: employeeId, hospitalId, gpsLat: { not: null } },
      data: { gpsLat: null, gpsLng: null },
    });
    if (result.count === 0) {
      throw new NotFoundException('Tasdiqlanmagan shaxsiy markaz topilmadi');
    }
    return { rejected: true };
  }

  /** Xodimning o'zi uchun: qayerlarda check-in qila oladi. */
  async myCenters(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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
    const e = user?.employee;
    if (!e) throw new NotFoundException('Xodim profili topilmadi');
    return buildGeoCenters({
      employee: e,
      position: e.position,
      hospital: e.hospital,
      sites: (e.workSites ?? []).map((w) => w.workSite),
    }).map(({ lat, lng, radius, name, source, workSiteId }) => ({
      lat,
      lng,
      radius,
      name,
      source,
      workSiteId,
    }));
  }

  private async findOwned(hospitalId: string, id: string) {
    const site = await this.prisma.workSite.findFirst({
      where: { id, hospitalId },
      select: { id: true },
    });
    if (!site) throw new NotFoundException('Ish joyi topilmadi');
    return site;
  }
}
