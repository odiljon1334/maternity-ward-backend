import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShiftDto } from './dto/create-shift.dto';

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(hospitalId: string | null) {
    return this.prisma.shiftTemplate.findMany({
      where: hospitalId ? { hospitalId } : {},
      orderBy: { type: 'asc' },
    });
  }

  async findOne(id: string, hospitalId: string | null) {
    const shift = await this.prisma.shiftTemplate.findFirst({
      where: hospitalId ? { id, hospitalId } : { id },
    });
    if (!shift) throw new NotFoundException('Smen topilmadi');
    return shift;
  }

  async create(dto: CreateShiftDto, hospitalId: string) {
    const exists = await this.prisma.shiftTemplate.findFirst({
      where: { hospitalId, name: dto.name },
    });
    if (exists) throw new ConflictException('Bu nomli smen mavjud');
    return this.prisma.shiftTemplate.create({ data: { ...dto, hospitalId } });
  }

  async update(id: string, dto: Partial<CreateShiftDto>, hospitalId: string) {
    await this.findOne(id, hospitalId);
    return this.prisma.shiftTemplate.update({ where: { id }, data: dto });
  }

  async remove(id: string, hospitalId: string) {
    await this.findOne(id, hospitalId);
    return this.prisma.shiftTemplate.delete({ where: { id } });
  }
}
