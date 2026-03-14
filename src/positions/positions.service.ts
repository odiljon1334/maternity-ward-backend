import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.position.findMany({
      include: { _count: { select: { employees: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const pos = await this.prisma.position.findUnique({ where: { id } });
    if (!pos) throw new NotFoundException('Lavozim topilmadi');
    return pos;
  }

  async create(data: { name: string }) {
    const exists = await this.prisma.position.findUnique({ where: { name: data.name } });
    if (exists) throw new ConflictException('Bu lavozim mavjud');
    return this.prisma.position.create({ data });
  }

  async update(id: string, data: { name: string }) {
    await this.findOne(id);
    return this.prisma.position.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.position.delete({ where: { id } });
  }
}
