import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { ResolveShiftDto } from './dto/resolve-shift.dto';
import { calcAutoLunch } from '../common/utils/shift.util';

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * hospitalId majburiy bo'lgan amallar uchun tekshiruv.
   *
   * ⚠️ tsconfig da `strictNullChecks: false` — shuning uchun controller
   * `resolveHospitalId(...)!` orqali null uzatsa TypeScript ogohlantirmaydi,
   * va Prisma tushunarsiz 500 xato beradi. Bu yerda tushunarli 400 qaytaramiz.
   * (SUPER_ADMIN da JWT hospitalId null bo'ladi, UI kasalxona tanlamagan
   * bo'lsa targetHospitalId ham yuborilmaydi.)
   */
  private requireHospitalId(hospitalId: string | null | undefined): string {
    if (!hospitalId) {
      throw new BadRequestException(
        "Kasalxona tanlanmagan. Yuqoridagi ro'yxatdan kasalxonani tanlang.",
      );
    }
    return hospitalId;
  }

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
    hospitalId = this.requireHospitalId(hospitalId);

    const exists = await this.prisma.shiftTemplate.findFirst({
      where: { hospitalId, name: dto.name },
    });
    if (exists) throw new ConflictException('Bu nomli smen mavjud');

    // Tushlik vaqti berilmagan bo'lsa — avtomatik hisoblash
    const isOvernight = dto.isOvernight ?? false;
    const autoLunch =
      !dto.lunchStart && !dto.lunchEnd
        ? calcAutoLunch(dto.startTime, dto.endTime, isOvernight)
        : {};

    return this.prisma.shiftTemplate.create({
      data: { ...dto, hospitalId, ...autoLunch },
    });
  }

  /**
   * Berilgan vaqt oralig'i uchun smenni TOPADI, bo'lmasa YARATADI.
   *
   * Grafik yaratishda har kunga har xil vaqt belgilash mumkin bo'lgani uchun
   * kerak: frontend "topib-yaratish" mantiqini o'zi bajarsa, nom bo'yicha
   * unique cheklov (hospitalId + name) tufayli 409 Conflict chiqishi mumkin.
   * Bu metod o'sha poyga holatini serverda hal qiladi.
   */
  async resolve(dto: ResolveShiftDto, hospitalId: string | null) {
    const startTime = dto.startTime.slice(0, 5);
    const endTime = dto.endTime.slice(0, 5);

    // employeeId dtodan ajratiladi — u ShiftTemplate maydoni emas
    const { employeeId, ...shiftData } = dto;

    // 0. Kasalxonani aniqlash.
    //    JWT dagi hospitalId SUPER_ADMIN uchun null, targetHospitalId esa
    //    UI da kasalxona tanlanmagan bo'lsa yuborilmaydi. Bunday holatda
    //    xodimning o'zidan aniqlaymiz — bu eng ishonchli manba.
    let hospId = hospitalId;
    if (!hospId && employeeId) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { hospitalId: true },
      });
      hospId = emp?.hospitalId ?? null;
    }
    hospId = this.requireHospitalId(hospId);

    // 1. Ayni vaqtli smen bormi?
    const existing = await this.prisma.shiftTemplate.findFirst({
      where: { hospitalId: hospId, type: dto.type, startTime, endTime },
    });
    if (existing) return existing;

    // 2. Yo'q — yaratamiz. Nom band bo'lsa, unikal nom tanlaymiz.
    const baseName = dto.name?.trim() || `${dto.type} ${startTime}-${endTime}`;
    const isOvernight = dto.isOvernight ?? false;
    const autoLunch =
      !dto.lunchStart && !dto.lunchEnd
        ? calcAutoLunch(startTime, endTime, isOvernight)
        : {};

    for (let attempt = 0; attempt < 10; attempt++) {
      const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
      try {
        return await this.prisma.shiftTemplate.create({
          data: {
            ...shiftData,
            name,
            startTime,
            endTime,
            isOvernight,
            hospitalId: hospId,
            ...autoLunch,
          },
        });
      } catch (e: any) {
        // P2002 = unique constraint (hospitalId + name) — boshqa nom bilan urinamiz
        if (e?.code !== 'P2002') throw e;
      }
    }

    throw new ConflictException("Smen yaratib bo'lmadi — nom band");
  }

  async update(id: string, dto: Partial<CreateShiftDto>, hospitalId: string) {
    await this.findOne(id, hospitalId);
    return this.prisma.shiftTemplate.update({ where: { id }, data: dto });
  }

  async remove(id: string, hospitalId: string) {
    await this.findOne(id, hospitalId);
    return this.prisma.shiftTemplate.delete({ where: { id } });
  }

  /** Default DAYTIME + NIGHTTIME smenlarini upsert qilish */
  async seed(hospitalId: string) {
    hospitalId = this.requireHospitalId(hospitalId);

    const defaults = [
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

    const results = [];
    for (const s of defaults) {
      const shift = await this.prisma.shiftTemplate.upsert({
        where: { hospitalId_name: { hospitalId, name: s.name } },
        update: s,
        create: { ...s, hospitalId },
      });
      results.push(shift);
    }
    return { message: 'Smenlar yaratildi', shifts: results };
  }
}
