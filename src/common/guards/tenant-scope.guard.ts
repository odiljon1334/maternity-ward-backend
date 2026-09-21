import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';

/**
 * ASSISTANT_ADMIN uchun tenant chegarasini server tomonda qat'iy saqlaydi.
 *
 * Frontend yuborgan `targetHospitalId` hech qachon ishonch manbai emas:
 * u faqat shu userga HospitalAssistant orqali biriktirilgan bo'lsa qabul
 * qilinadi. Bitta muassasa bo'lsa uni avtomatik tanlaymiz, bir nechtasida
 * esa aniq tanlov talab qilinadi — aks holda filtersiz query ma'lumotni
 * boshqa tenantlardan ham qaytarib yuborishi mumkin.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as
      { sub?: string; role?: UserRole; hospitalId?: string | null } | undefined;

    if (!user || user.role !== UserRole.ASSISTANT_ADMIN) return true;

    const assignments = await this.prisma.hospitalAssistant.findMany({
      where: { userId: user.sub },
      select: { hospitalId: true },
    });
    const allowedIds = assignments.map((assignment) => assignment.hospitalId);
    if (allowedIds.length === 0) {
      throw new ForbiddenException(
        'Sizga hali birorta muassasa biriktirilmagan',
      );
    }

    const requestedId =
      request.query?.targetHospitalId ??
      request.query?.hospitalId ??
      request.query?.queryHospitalId ??
      request.body?.targetHospitalId ??
      request.body?.hospitalId ??
      request.params?.hospitalId;
    if (requestedId && !allowedIds.includes(requestedId)) {
      throw new ForbiddenException(
        'Sizga tanlangan muassasaga kirish huquqi berilmagan',
      );
    }

    if (!requestedId && allowedIds.length > 1) {
      throw new ForbiddenException(
        "Avval ishlamoqchi bo'lgan muassasani tanlang",
      );
    }

    const hospitalId = requestedId || allowedIds[0];
    // Legacy controllerlar CurrentUser('hospitalId') orqali oladi. Uni faqat
    // guard tasdiqlagan qiymatga almashtirish targetHospitalId bypass'ini
    // barcha qamrab olingan route'larda birdan yopadi.
    request.user.hospitalId = hospitalId;
    if (request.query) {
      request.query.targetHospitalId = hospitalId;
      request.query.hospitalId = hospitalId;
      request.query.queryHospitalId = hospitalId;
    }
    if (request.body?.hospitalId) request.body.hospitalId = hospitalId;

    return true;
  }
}
