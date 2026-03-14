import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.department.findMany({
      include: { _count: { select: { employees: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      include: {
        employees: {
          include: { position: true },
          where: { firedAt: null },
        },
      },
    });
    if (!dept) throw new NotFoundException('Bo\'lim topilmadi');
    return dept;
  }

  async create(data: { name: string; code: string; description?: string }) {
    const exists = await this.prisma.department.findUnique({ where: { code: data.code } });
    if (exists) throw new ConflictException('Bu kod bilan bo\'lim mavjud');
    return this.prisma.department.create({ data });
  }

  async update(id: string, data: { name?: string; description?: string }) {
    await this.findOne(id);
    return this.prisma.department.update({ where: { id }, data });
  }

  async remove(id: string) {
    const dept = await this.findOne(id);
    if (dept.employees.length > 0) {
      throw new ConflictException('Bo\'limda hodimlar bor, o\'chirib bo\'lmaydi');
    }
    return this.prisma.department.delete({ where: { id } });
  }
}
