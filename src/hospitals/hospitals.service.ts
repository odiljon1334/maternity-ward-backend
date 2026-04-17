import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
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

    return hospitals.map(h => {
      const dirUser = h.users?.[0] ?? null;
      const directorName  = dirUser?.employee?.fullName ?? dirUser?.username ?? null;
      const directorPhone = dirUser?.employee?.phone ?? null;

      return {
        ...h,
        directorName,
        directorPhone,
        directorHasPhone: !!directorPhone,
        telegramLinked: (h._count?.telegramSubs ?? 0) > 0,
        users: undefined, // frontend ga raw User ma'lumoti kerak emas
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
    if (!h) throw new NotFoundException('Tug\'ruq xona topilmadi');
    return h;
  }

  async create(data: {
    name: string;
    code: string;
    address?: string;
    phone?: string;
  }) {
    const exists = await this.prisma.hospital.findUnique({ where: { code: data.code } });
    if (exists) throw new ConflictException('Bu kod bilan tug\'ruq xona allaqachon mavjud');
    return this.prisma.hospital.create({ data });
  }

  async update(id: string, data: {
    name?: string;
    address?: string;
    phone?: string;
    isActive?: boolean;
  }) {
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
  async createDirector(hospitalId: string, dto: {
    username: string;
    password: string;
    fullName: string;
    phone?: string;
  }) {
    const hospital = await this.findOne(hospitalId);

    const existing = await this.prisma.user.findUnique({ where: { username: dto.username } });
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

      return { user: { id: user.id, username: user.username, role: user.role }, employee, hospital };
    });
  }
}
