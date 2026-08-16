import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(hospitalId: string | null) {
    return this.prisma.department.findMany({
      where: hospitalId ? { hospitalId } : {},
      include: { _count: { select: { employees: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, hospitalId: string | null) {
    const where: any = { id };
    if (hospitalId) where.hospitalId = hospitalId;
    const dept = await this.prisma.department.findFirst({
      where,
      include: {
        employees: {
          include: { position: true },
          where: { firedAt: null },
        },
      },
    });
    if (!dept) throw new NotFoundException("Bo'lim topilmadi");
    return dept;
  }

  async create(
    data: { name: string; code: string; description?: string },
    hospitalId: string,
  ) {
    const exists = await this.prisma.department.findFirst({
      where: { hospitalId, code: data.code },
    });
    if (exists) throw new ConflictException("Bu kod bilan bo'lim mavjud");
    return this.prisma.department.create({ data: { ...data, hospitalId } });
  }

  async update(
    id: string,
    data: { name?: string; description?: string },
    hospitalId: string | null,
  ) {
    await this.findOne(id, hospitalId);
    return this.prisma.department.update({ where: { id }, data });
  }

  async remove(id: string, hospitalId: string | null) {
    const dept = await this.findOne(id, hospitalId);
    if (dept.employees.length > 0) {
      throw new ConflictException("Bo'limda hodimlar bor, o'chirib bo'lmaydi");
    }
    return this.prisma.department.delete({ where: { id } });
  }
}
