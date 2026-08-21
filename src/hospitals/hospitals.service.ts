import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HospitalsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const hospitals = await this.prisma.hospital.findMany({
      include: {
        _count: {
          select: {
            employees: true,
            departments: true,
            users: true,
            telegramSubs: { where: { isActive: true } },
          },
        },
        // Direktor user (DIRECTOR roli bilan)
        users: {
          where: { role: 'DIRECTOR' },
          select: {
            id: true,
            username: true,
            employee: { select: { fullName: true, phone: true } },
          },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });

    return hospitals.map((h) => {
      const dirUser = h.users?.[0] ?? null;
      const directorName =
        dirUser?.employee?.fullName ?? dirUser?.username ?? null;
      const directorPhone = dirUser?.employee?.phone ?? null;

      return {
        ...h,
        directorId: dirUser?.id ?? null,
        directorUsername: dirUser?.username ?? null,
        directorName,
        directorPhone,
        directorHasPhone: !!directorPhone,
        telegramLinked: (h._count?.telegramSubs ?? 0) > 0,
        users: undefined,
      };
    });
  }

  async findOne(id: string) {
    const h = await this.prisma.hospital.findUnique({
      where: { id },
      include: {
        departments: { orderBy: { name: 'asc' } },
        _count: { select: { employees: true, users: true } },
      },
    });
    if (!h) throw new NotFoundException("Tug'ruq xona topilmadi");
    return h;
  }

  async create(data: {
    name: string;
    code: string;
    address?: string;
    phone?: string;
  }) {
    const exists = await this.prisma.hospital.findUnique({
      where: { code: data.code },
    });
    if (exists)
      throw new ConflictException(
        "Bu kod bilan tug'ruq xona allaqachon mavjud",
      );
    return this.prisma.hospital.create({ data });
  }

  async update(
    id: string,
    data: {
      name?: string;
      address?: string;
      phone?: string;
      isActive?: boolean;
      gpsLat?: number;
      gpsLng?: number;
      gpsRadius?: number;
    },
  ) {
    await this.findOne(id);
    return this.prisma.hospital.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.hospital.delete({ where: { id } });
  }

  async setBlocked(id: string, isBlocked: boolean) {
    await this.findOne(id);
    return this.prisma.hospital.update({
      where: { id },
      data: { isBlocked },
      select: { id: true, name: true, isBlocked: true },
    });
  }

  // Create a director user for a hospital
  async createDirector(
    hospitalId: string,
    dto: {
      username: string;
      password: string;
      fullName: string;
      phone?: string;
    },
  ) {
    const hospital = await this.findOne(hospitalId);

    const existing = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (existing) throw new ConflictException('Bu username allaqachon mavjud');

    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.hash(dto.password, 12);

    // Find or create default ADMIN position
    let pos = await this.prisma.position.findFirst({
      where: { hospitalId, name: 'Direktor' },
    });
    if (!pos) {
      pos = await this.prisma.position.create({
        data: { name: 'Direktor', hospitalId },
      });
    }

    let dept = await this.prisma.department.findFirst({
      where: { hospitalId, code: 'ADMIN' },
    });
    if (!dept) {
      dept = await this.prisma.department.create({
        data: { name: "Ma'muriyat", code: 'ADMIN', hospitalId },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // ── Eski direktor(lar) ni EMPLOYEE ga demote qilish ────────────────────
      // O'chirish o'rniga rol EMPLOYEE ga o'zgartiriladi — tarixiy ma'lumotlar saqlanadi
      const oldDirUsers = await tx.user.findMany({
        where: { hospitalId, role: 'DIRECTOR' },
      });
      for (const oldUser of oldDirUsers) {
        await tx.user.update({
          where: { id: oldUser.id },
          data: { role: 'EMPLOYEE' },
        });
      }

      // userId=null bo'lib qolgan "yetim" director employee larni o'chirish
      // (avval qo'lda user o'chirilgan holat uchun)
      await tx.employee.deleteMany({
        where: {
          hospitalId,
          userId: null,
          position: { name: 'Direktor' },
        },
      });

      // ── Yangi direktor yaratish ─────────────────────────────────────────────
      const user = await tx.user.create({
        data: {
          username: dto.username,
          passwordHash: hash,
          role: 'DIRECTOR',
          status: 'ACTIVE',
          hospitalId,
        },
      });

      const employee = await tx.employee.create({
        data: {
          fullName: dto.fullName,
          gender: 'MALE',
          phone: dto.phone,
          departmentId: dept.id,
          positionId: pos.id,
          baseSalary: 0,
          hospitalId,
          userId: user.id,
        },
      });

      return {
        user: { id: user.id, username: user.username, role: user.role },
        employee,
        hospital,
      };
    });
  }

  // Update director for a hospital
  async updateDirector(
    hospitalId: string,
    dto: {
      fullName?: string;
      phone?: string;
      password?: string;
    },
  ) {
    const hospital = await this.findOne(hospitalId);

    const dirUser = await this.prisma.user.findFirst({
      where: { hospitalId, role: 'DIRECTOR' },
      include: { employee: true },
    });
    if (!dirUser) throw new NotFoundException('Direktor topilmadi');

    return this.prisma.$transaction(async (tx) => {
      if (dto.password) {
        const bcrypt = await import('bcrypt');
        const hash = await bcrypt.hash(dto.password, 12);
        await tx.user.update({
          where: { id: dirUser.id },
          data: { passwordHash: hash },
        });
      }

      if (dto.fullName !== undefined || dto.phone !== undefined) {
        if (dirUser.employee) {
          await tx.employee.update({
            where: { id: dirUser.employee.id },
            data: {
              ...(dto.fullName !== undefined && { fullName: dto.fullName }),
              ...(dto.phone !== undefined && { phone: dto.phone }),
            },
          });
        }
      }

      return { success: true, message: 'Direktor yangilandi' };
    });
  }

  /** DIRECTOR: geofencing radiusini o'zgartirish (50–2000 metr) */
  async updateGpsRadius(hospitalId: string, radius: number) {
    if (radius < 50 || radius > 2000) {
      const { BadRequestException } = await import('@nestjs/common');
      throw new BadRequestException(
        "Radius 50 – 2000 metr oralig'ida bo'lishi kerak",
      );
    }
    return this.prisma.hospital.update({
      where: { id: hospitalId },
      data: { gpsRadius: radius },
      select: { id: true, gpsRadius: true },
    });
  }

  /** DIRECTOR: kasalxona GPS ni reset qilish (qayta o'rnatish uchun) */
  async resetGps(hospitalId: string) {
    return this.prisma.hospital.update({
      where: { id: hospitalId },
      data: { gpsLat: null, gpsLng: null },
      select: { id: true, gpsLat: true, gpsLng: true },
    });
  }

  /** Kasalxonadagi barcha Telegram obunalarini o'chirish.
   *  Eski direktor o'chirilganda qolib ketgan subscriptionlarni tozalash uchun. */
  async resetTelegramSubs(hospitalId: string) {
    const { count } = await this.prisma.telegramSubscription.updateMany({
      where: { hospitalId, isActive: true },
      data: { isActive: false },
    });
    return {
      success: true,
      deactivated: count,
      message:
        count > 0
          ? `${count} ta Telegram obuna o'chirildi. Yangi direktor /start orqali qayta ulana oladi.`
          : 'Faol Telegram obuna topilmadi.',
    };
  }
}
