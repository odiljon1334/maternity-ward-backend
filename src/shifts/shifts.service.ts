import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShiftDto } from './dto/create-shift.dto';

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.shiftTemplate.findMany({ orderBy: { type: 'asc' } });
  }

  async findOne(id: string) {
    const shift = await this.prisma.shiftTemplate.findUnique({ where: { id } });
    if (!shift) throw new NotFoundException('Smen topilmadi');
    return shift;
  }

  async create(dto: CreateShiftDto) {
    const exists = await this.prisma.shiftTemplate.findUnique({ where: { name: dto.name } });
    if (exists) throw new ConflictException('Bu nomli smen mavjud');
    return this.prisma.shiftTemplate.create({ data: dto });
  }

  async update(id: string, dto: Partial<CreateShiftDto>) {
    await this.findOne(id);
    return this.prisma.shiftTemplate.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.shiftTemplate.delete({ where: { id } });
  }

  async seed() {
    const shifts = [
      {
        name: 'Kunduzgi smen',
        type: 'DAYTIME' as const,
        startTime: '08:00',
        endTime: '20:00',
        isOvernight: false,
        durationH: 12,
        graceMinutes: 15,
      },
      {
        name: 'Kechki smen',
        type: 'NIGHTTIME' as const,
        startTime: '20:00',
        endTime: '08:00',
        isOvernight: true,
        durationH: 12,
        graceMinutes: 15,
      },
    ];

    for (const s of shifts) {
      await this.prisma.shiftTemplate.upsert({
        where: { name: s.name },
        update: s,
        create: s,
      });
    }
    return { message: 'Default smenlar yaratildi' };
  }
}
