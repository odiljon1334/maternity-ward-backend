import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueryUsersDto } from './dto/query-users.dto';
import { UserRole, UserStatus } from '@prisma/client';
import {
  ROLE_DEFAULT_PERMISSIONS,
  computeEffectivePermissions,
} from '../common/permissions';

// Platforma darajasidagi rollar — shu umumiy panel orqali tayinlanmaydi/olib
// tashlanmaydi (alohida, ataylab qilinadigan jarayon talab qiladi).
import { assertCanManageRole } from '../common/utils/role-rank.util';

const PLATFORM_ROLES: UserRole[] = [UserRole.SUPER_ADMIN, UserRole.MINISTRY];

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryUsersDto, hospitalId: string | null) {
    const { search, role, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      ...(hospitalId ? { hospitalId } : {}),
      ...(role && { role }),
      ...(status && { status }),
      ...(search && {
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          {
            employee: {
              fullName: { contains: search, mode: 'insensitive' },
            },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          hospitalId: true,
          hospital: { select: { id: true, name: true, code: true } },
          employee: {
            select: {
              fullName: true,
              phone: true,
              department: { select: { name: true } },
              position: { select: { name: true } },
            },
          },
        },
        orderBy: [{ username: 'asc' }],
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private async findOneOrThrow(id: string, hospitalId: string | null) {
    const user = await this.prisma.user.findFirst({
      where: { id, ...(hospitalId ? { hospitalId } : {}) },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return user;
  }

  async updateStatus(
    id: string,
    status: UserStatus,
    hospitalId: string | null,
    actorRole?: UserRole,
  ) {
    const user = await this.findOneOrThrow(id, hospitalId);
    if (actorRole) {
      assertCanManageRole(
        actorRole,
        user.role,
        "bu hisob holatini o'zgartirish",
      );
    }

    if (PLATFORM_ROLES.includes(user.role)) {
      throw new BadRequestException(
        "Platforma darajasidagi foydalanuvchi holatini shu yerdan o'zgartirib bo'lmaydi",
      );
    }

    return this.prisma.user.update({
      where: { id },
      data: { status },
      select: { id: true, username: true, status: true },
    });
  }

  async updateRole(id: string, role: UserRole, hospitalId: string | null) {
    const user = await this.findOneOrThrow(id, hospitalId);

    if (PLATFORM_ROLES.includes(user.role) || PLATFORM_ROLES.includes(role)) {
      throw new BadRequestException(
        'Platforma darajasidagi rollar (SUPER_ADMIN/MINISTRY) shu yerdan tayinlanmaydi',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (role === 'DIRECTOR' && user.hospitalId) {
        // Eski direktor(lar)ni EMPLOYEE'ga tushirish — hospitals.service.ts
        // (createDirector) bilan bir xil naqsh: o'chirish o'rniga demote.
        await tx.user.updateMany({
          where: {
            hospitalId: user.hospitalId,
            role: 'DIRECTOR',
            id: { not: id },
          },
          data: { role: 'EMPLOYEE' },
        });
      }

      return tx.user.update({
        where: { id },
        data: { role },
        select: { id: true, username: true, role: true },
      });
    });
  }

  /**
   * Foydalanuvchining standart (rol bo'yicha) va effektiv (override'lar
   * bilan) ruxsatlarini, hamda saqlangan override yozuvlarini qaytaradi —
   * frontend "Ruxsatlar" panelida shu asosida toggle ko'rsatiladi.
   */
  async getPermissions(id: string, hospitalId: string | null) {
    const user = await this.findOneOrThrow(id, hospitalId);

    if (PLATFORM_ROLES.includes(user.role)) {
      throw new BadRequestException(
        'Platforma darajasidagi foydalanuvchi uchun ruxsatlar shu yerdan boshqarilmaydi',
      );
    }

    const overrides = await this.prisma.userPermissionOverride.findMany({
      where: { userId: id },
      orderBy: { permission: 'asc' },
      select: { permission: true, granted: true, updatedAt: true },
    });

    return {
      userId: user.id,
      role: user.role,
      defaults: ROLE_DEFAULT_PERMISSIONS[user.role] ?? [],
      overrides,
      effective: computeEffectivePermissions(user.role, overrides),
    };
  }

  /**
   * `granted: true/false` — standartdan chetga chiquvchi override
   * yozadi/yangilaydi. `granted: null/undefined` — override'ni o'chirib,
   * foydalanuvchini standart rol-ruxsatlariga qaytaradi.
   */
  async setPermissionOverride(
    id: string,
    hospitalId: string | null,
    permission: string,
    granted: boolean | null | undefined,
  ) {
    const user = await this.findOneOrThrow(id, hospitalId);

    if (PLATFORM_ROLES.includes(user.role)) {
      throw new BadRequestException(
        'Platforma darajasidagi foydalanuvchi uchun ruxsatlar shu yerdan boshqarilmaydi',
      );
    }

    if (granted === null || granted === undefined) {
      await this.prisma.userPermissionOverride.deleteMany({
        where: { userId: id, permission },
      });
    } else {
      await this.prisma.userPermissionOverride.upsert({
        where: { userId_permission: { userId: id, permission } },
        update: { granted },
        create: { userId: id, permission, granted },
      });
    }

    return this.getPermissions(id, hospitalId);
  }
}
