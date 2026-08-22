import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(hospitalId: string | null) {
    return this.prisma.position.findMany({
      where: hospitalId ? { hospitalId } : {},
      include: { _count: { select: { employees: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, hospitalId: string | null) {
    const where: any = { id };
    if (hospitalId) where.hospitalId = hospitalId;
    const pos = await this.prisma.position.findFirst({ where });
    if (!pos) throw new NotFoundException('Lavozim topilmadi');
    return pos;
  }

  async create(data: { name: string }, hospitalId: string) {
    const exists = await this.prisma.position.findFirst({
      where: { hospitalId, name: data.name },
    });
    if (exists) throw new ConflictException('Bu lavozim mavjud');
    return this.prisma.position.create({ data: { ...data, hospitalId } });
  }

  async update(id: string, data: { name: string }, hospitalId: string | null) {
    await this.findOne(id, hospitalId);
    return this.prisma.position.update({ where: { id }, data });
  }

  async updateGps(
    id: string,
    hospitalId: string | null,
    data: {
      gpsLat?: number | null;
      gpsLng?: number | null;
      gpsRadius?: number | null;
    },
  ) {
    await this.findOne(id, hospitalId);
    return this.prisma.position.update({
      where: { id },
      data: {
        gpsLat: data.gpsLat,
        gpsLng: data.gpsLng,
        gpsRadius: data.gpsRadius ?? 100,
      },
      select: {
        id: true,
        name: true,
        gpsLat: true,
        gpsLng: true,
        gpsRadius: true,
      },
    });
  }

  async resetGps(id: string, hospitalId: string | null) {
    await this.findOne(id, hospitalId);
    return this.prisma.position.update({
      where: { id },
      data: { gpsLat: null, gpsLng: null },
      select: { id: true, name: true, gpsLat: true, gpsLng: true },
    });
  }

  async remove(id: string, hospitalId: string | null) {
    await this.findOne(id, hospitalId);
    return this.prisma.position.delete({ where: { id } });
  }
}
