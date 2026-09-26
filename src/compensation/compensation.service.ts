import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  PayrollAdjustmentStatus,
  PayrollAdjustmentType,
  Prisma,
  SalaryAdvanceStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import { calcShiftNetMinutes } from '../common/utils/shift.util';
import {
  AdjustmentDecisionDto,
  AdvanceDecisionDto,
  CreateAdjustmentDto,
  MarkAdvancePaidDto,
  RequestAdvanceDto,
} from './dto/compensation.dto';

@Injectable()
export class CompensationService {
  constructor(private readonly prisma: PrismaService) {}

  private notifyEmployee(
    userId: string | null | undefined,
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    if (!userId) return;
    this.prisma.notification
      .create({
        data: {
          userId,
          type: NotificationType.SYSTEM,
          title,
          message,
          metadata: metadata as Prisma.InputJsonValue | undefined,
        },
      })
      .catch(() => undefined);
  }

  private async employeeInScope(employeeId: string, hospitalId?: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, ...(hospitalId && { hospitalId }) },
      select: { id: true, userId: true, hospitalId: true, baseSalary: true },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');
    return employee;
  }

  async createAdjustment(
    actorId: string,
    hospitalId: string | undefined,
    dto: CreateAdjustmentDto,
  ) {
    const employee = await this.employeeInScope(dto.employeeId, hospitalId);
    const isFine = dto.type === PayrollAdjustmentType.DISCIPLINARY_FINE;
    let proposedAmount = dto.proposedAmount;

    if (
      dto.type === PayrollAdjustmentType.CONTRACTUAL_KPI_BONUS &&
      !dto.policyReference
    ) {
      throw new BadRequestException(
        'KPI bonusi uchun amaldagi KPI nizomi yoki mezon versiyasi kerak',
      );
    }
    if (
      dto.type === PayrollAdjustmentType.OVERTIME_PAY &&
      (!dto.evidence ||
        Object.keys(dto.evidence).length === 0 ||
        !dto.policyReference)
    ) {
      throw new BadRequestException(
        'Overtime to‘lovi uchun jalb qilish asosi/rozilik hujjati va vaqt hisobi dalili kerak',
      );
    }
    if (dto.type === PayrollAdjustmentType.OVERTIME_PAY) {
      const start = DateUtil.startOfMonth(dto.year, dto.month);
      const end = DateUtil.endOfMonth(dto.year, dto.month);
      const [records, schedules] = await Promise.all([
        this.prisma.attendanceRecord.findMany({
          where: {
            employeeId: employee.id,
            workDate: { gte: start, lte: end },
            overtimeMinutes: { gt: 0 },
          },
          include: { schedule: { include: { shift: true } } },
        }),
        this.prisma.schedule.findMany({
          where: {
            employeeId: employee.id,
            date: { gte: start, lte: end },
            status: 'WORKING',
          },
          include: { shift: true },
        }),
      ]);
      if (
        records.some((record) => (record.schedule?.shift?.durationH ?? 0) >= 12)
      ) {
        throw new BadRequestException(
          '12 soatlik smenada overtimega yo‘l qo‘yilmaydi; yozuvni tekshiring',
        );
      }
      const normativeMinutes = schedules.reduce(
        (sum, schedule) =>
          sum + (schedule.shift ? calcShiftNetMinutes(schedule.shift) : 0),
        0,
      );
      if (normativeMinutes <= 0) {
        throw new BadRequestException(
          'Overtime stavkasini hisoblash uchun tasdiqlangan grafik topilmadi',
        );
      }
      const minuteRate = Number(employee.baseSalary) / normativeMinutes;
      proposedAmount = Math.round(
        records.reduce((sum, record) => {
          const firstTwoHours = Math.min(record.overtimeMinutes, 120);
          const afterTwoHours = Math.max(0, record.overtimeMinutes - 120);
          return (
            sum +
            firstTwoHours * minuteRate * 1.5 +
            afterTwoHours * minuteRate * 2
          );
        }, 0),
      );
      if (proposedAmount <= 0) {
        throw new BadRequestException(
          'Tasdiqlash uchun overtime vaqti topilmadi',
        );
      }
    }

    const result = await this.prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        hospitalId: employee.hospitalId,
        month: dto.month,
        year: dto.year,
        type: dto.type,
        status: isFine
          ? PayrollAdjustmentStatus.PENDING_EXPLANATION
          : PayrollAdjustmentStatus.PENDING_APPROVAL,
        proposedAmount,
        reason: dto.reason.trim(),
        policyReference: dto.policyReference?.trim(),
        evidence: dto.evidence as Prisma.InputJsonValue | undefined,
        calculationBaseAmount: isFine
          ? (dto.calculationBaseAmount ?? Number(employee.baseSalary))
          : undefined,
        explanationRequestedAt: isFine ? new Date() : undefined,
        createdById: actorId,
      },
      include: { employee: { select: { id: true, fullName: true } } },
    });
    this.notifyEmployee(
      employee.userId,
      isFine ? 'Tushuntirish so‘raldi' : 'Yangi hisob-kitob yozuvi',
      isFine
        ? 'Intizomiy holat bo‘yicha tushuntirishingiz kutilmoqda.'
        : 'KPI, mukofot yoki ish haqi tuzatishi ko‘rib chiqilmoqda.',
      { adjustmentId: result.id, type: dto.type },
    );
    return result;
  }

  async submitExplanation(id: string, userId: string, explanation: string) {
    const adjustment = await this.prisma.payrollAdjustment.findFirst({
      where: { id, employee: { userId } },
    });
    if (!adjustment) throw new NotFoundException('Jarima ishi topilmadi');
    if (
      adjustment.type !== PayrollAdjustmentType.DISCIPLINARY_FINE ||
      adjustment.status !== PayrollAdjustmentStatus.PENDING_EXPLANATION
    ) {
      throw new ConflictException('Bu ish uchun tushuntirish qabul qilinmaydi');
    }

    return this.prisma.payrollAdjustment.update({
      where: { id },
      data: {
        employeeExplanation: explanation.trim(),
        explanationSubmittedAt: new Date(),
        status: PayrollAdjustmentStatus.PENDING_APPROVAL,
      },
    });
  }

  async acknowledgeAdjustment(id: string, userId: string) {
    const adjustment = await this.prisma.payrollAdjustment.findFirst({
      where: { id, employee: { userId } },
    });
    if (!adjustment) throw new NotFoundException('Jarima buyrug‘i topilmadi');
    if (
      adjustment.type !== PayrollAdjustmentType.DISCIPLINARY_FINE ||
      adjustment.status !== PayrollAdjustmentStatus.PENDING_ACKNOWLEDGEMENT
    ) {
      throw new ConflictException('Bu buyruq tanishtirish uchun ochiq emas');
    }
    return this.prisma.payrollAdjustment.update({
      where: { id },
      data: {
        acknowledgedAt: new Date(),
        status: PayrollAdjustmentStatus.APPROVED,
      },
    });
  }

  async decideAdjustment(
    id: string,
    actorId: string,
    hospitalId: string | undefined,
    dto: AdjustmentDecisionDto,
  ) {
    const item = await this.prisma.payrollAdjustment.findFirst({
      where: { id, ...(hospitalId && { hospitalId }) },
      include: { employee: { select: { userId: true } } },
    });
    if (!item) throw new NotFoundException('Hisob-kitob yozuvi topilmadi');
    if (
      item.status !== PayrollAdjustmentStatus.PENDING_EXPLANATION &&
      item.status !== PayrollAdjustmentStatus.PENDING_APPROVAL
    ) {
      throw new ConflictException(
        'Bu yozuv bo‘yicha qaror allaqachon berilgan',
      );
    }

    if (dto.decision === 'REJECTED') {
      const rejected = await this.prisma.payrollAdjustment.update({
        where: { id },
        data: {
          status: PayrollAdjustmentStatus.REJECTED,
          decidedById: actorId,
          decidedAt: new Date(),
          decisionReason: dto.decisionReason.trim(),
        },
      });
      this.notifyEmployee(
        item.employee?.userId,
        'Hisob-kitob yozuvi rad etildi',
        dto.decisionReason,
        { adjustmentId: id },
      );
      return rejected;
    }

    const approvedAmount = dto.approvedAmount ?? Number(item.proposedAmount);
    if (
      item.type === PayrollAdjustmentType.CONTRACTUAL_KPI_BONUS &&
      approvedAmount !== Number(item.proposedAmount)
    ) {
      throw new BadRequestException(
        'Shartli KPI mezoni bajarilgan bo‘lsa hisoblangan summa o‘zgartirilmaydi; mezon xato bo‘lsa dalil bilan rad eting',
      );
    }
    if (
      item.type === PayrollAdjustmentType.OVERTIME_PAY &&
      approvedAmount < Number(item.proposedAmount)
    ) {
      throw new BadRequestException(
        'Overtime to‘lovi qonuniy minimal hisoblangan summadan kamaytirilmaydi',
      );
    }
    if (
      (item.type === PayrollAdjustmentType.DISCIPLINARY_FINE ||
        item.type === PayrollAdjustmentType.OTHER_LAWFUL_DEDUCTION) &&
      approvedAmount > Number(item.proposedAmount)
    ) {
      throw new BadRequestException(
        'Ushlanma dastlab taklif qilingan summadan oshirilmaydi',
      );
    }
    const data: Record<string, unknown> = {
      status:
        item.type === PayrollAdjustmentType.DISCIPLINARY_FINE
          ? PayrollAdjustmentStatus.PENDING_ACKNOWLEDGEMENT
          : PayrollAdjustmentStatus.APPROVED,
      approvedAmount,
      decidedById: actorId,
      decidedAt: new Date(),
      decisionReason: dto.decisionReason.trim(),
    };

    if (item.type === PayrollAdjustmentType.DISCIPLINARY_FINE) {
      if (!item.employeeExplanation && !dto.explanationRefused) {
        throw new BadRequestException(
          'Avval xodim tushuntirishi yoki tushuntirishdan bosh tortish dalolatnomasi kerak',
        );
      }
      if (dto.explanationRefused && !dto.refusalActReference) {
        throw new BadRequestException(
          'Tushuntirishdan bosh tortish dalolatnomasi raqami majburiy',
        );
      }
      if (!dto.orderNumber || !dto.orderDate) {
        throw new BadRequestException(
          'Intizomiy jarima uchun buyruq raqami va sanasi majburiy',
        );
      }
      const percent = dto.finePercent ?? 30;
      if (percent > 30 && !dto.policyReference) {
        throw new BadRequestException(
          '30% dan yuqori jarima uchun ichki mehnat tartibi bandi kerak',
        );
      }
      const calculationBase = Number(item.calculationBaseAmount);
      if (approvedAmount > (calculationBase * percent) / 100) {
        throw new BadRequestException(
          `Jarima ko‘rsatilgan hisoblash bazasining ${percent}% limitidan oshdi`,
        );
      }
      Object.assign(data, {
        orderNumber: dto.orderNumber.trim(),
        orderDate: new Date(dto.orderDate),
        finePercent: percent,
        policyReference: dto.policyReference ?? item.policyReference,
        explanationRefusedAt: dto.explanationRefused ? new Date() : undefined,
        evidence: dto.explanationRefused
          ? {
              ...((item.evidence as Record<string, unknown> | null) ?? {}),
              refusalActReference: dto.refusalActReference,
            }
          : item.evidence,
      });
    }

    const decided = await this.prisma.payrollAdjustment.update({
      where: { id },
      data,
    });
    this.notifyEmployee(
      item.employee?.userId,
      item.type === PayrollAdjustmentType.DISCIPLINARY_FINE
        ? 'Intizomiy buyruq bilan tanishing'
        : 'Hisob-kitob yozuvi tasdiqlandi',
      item.type === PayrollAdjustmentType.DISCIPLINARY_FINE
        ? `Buyruq ${dto.orderNumber} bilan tanishishingiz kerak.`
        : dto.decisionReason,
      { adjustmentId: id },
    );
    return decided;
  }

  listAdjustments(params: {
    hospitalId?: string;
    employeeId?: string;
    month?: number;
    year?: number;
  }) {
    return this.prisma.payrollAdjustment.findMany({
      where: {
        ...(params.hospitalId && { hospitalId: params.hospitalId }),
        ...(params.employeeId && { employeeId: params.employeeId }),
        ...(params.month && { month: params.month }),
        ...(params.year && { year: params.year }),
      },
      include: { employee: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async myAdjustments(userId: string, month?: number, year?: number) {
    const employee = await this.prisma.employee.findFirst({
      where: { userId },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');
    return this.listAdjustments({ employeeId: employee.id, month, year });
  }

  async requestAdvance(
    actorId: string,
    actorIsEmployee: boolean,
    hospitalId: string | undefined,
    dto: RequestAdvanceDto,
  ) {
    const employee = actorIsEmployee
      ? await this.prisma.employee.findFirst({ where: { userId: actorId } })
      : dto.employeeId
        ? await this.employeeInScope(dto.employeeId, hospitalId)
        : null;
    if (!employee) throw new NotFoundException('Xodim topilmadi');
    const base = Number(employee.baseSalary);
    if (dto.amount > base) {
      throw new BadRequestException(
        'Avans bazaviy oylikdan yuqori bo‘lishi mumkin emas',
      );
    }

    if (actorIsEmployee) {
      // Xodim faqat joriy yoki keyingi oy uchun so'ray oladi (Toshkent vaqti)
      const now = DateUtil.now();
      const next = now.add(1, 'month');
      const allowed = [
        { m: now.month() + 1, y: now.year() },
        { m: next.month() + 1, y: next.year() },
      ];
      if (!allowed.some((p) => p.m === dto.month && p.y === dto.year)) {
        throw new BadRequestException(
          'Avans faqat joriy yoki keyingi oy uchun so‘raladi',
        );
      }

      const active = await this.prisma.salaryAdvance.findMany({
        where: {
          employeeId: employee.id,
          month: dto.month,
          year: dto.year,
          status: {
            in: [
              SalaryAdvanceStatus.REQUESTED,
              SalaryAdvanceStatus.APPROVED,
              SalaryAdvanceStatus.PAID,
            ],
          },
        },
        select: {
          status: true,
          requestedAmount: true,
          approvedAmount: true,
          paidAmount: true,
        },
      });
      if (active.some((a) => a.status === SalaryAdvanceStatus.REQUESTED)) {
        throw new ConflictException(
          'Bu oy uchun avans so‘rovingiz ko‘rib chiqilmoqda',
        );
      }
      const taken = active.reduce(
        (sum, a) =>
          sum +
          Number(a.paidAmount ?? a.approvedAmount ?? a.requestedAmount ?? 0),
        0,
      );
      if (taken + dto.amount > base) {
        throw new BadRequestException(
          'Oy davomidagi avanslar jami bazaviy oylikdan oshmasligi kerak',
        );
      }
    }

    return this.prisma.salaryAdvance.create({
      data: {
        employeeId: employee.id,
        hospitalId: employee.hospitalId,
        month: dto.month,
        year: dto.year,
        requestedAmount: dto.amount,
        note: dto.note?.trim(),
        requestedById: actorId,
      },
    });
  }

  async decideAdvance(
    id: string,
    actorId: string,
    hospitalId: string | undefined,
    dto: AdvanceDecisionDto,
  ) {
    const item = await this.prisma.salaryAdvance.findFirst({
      where: { id, ...(hospitalId && { hospitalId }) },
      include: { employee: { select: { baseSalary: true, userId: true } } },
    });
    if (!item) throw new NotFoundException('Avans so‘rovi topilmadi');
    if (item.status !== SalaryAdvanceStatus.REQUESTED) {
      throw new ConflictException(
        'Bu avans so‘rovi allaqachon ko‘rib chiqilgan',
      );
    }
    if (dto.decision === 'REJECTED') {
      const rejected = await this.prisma.salaryAdvance.update({
        where: { id },
        data: {
          status: SalaryAdvanceStatus.REJECTED,
          approvedById: actorId,
          approvedAt: new Date(),
          note: dto.note ?? item.note,
        },
      });
      this.notifyEmployee(
        item.employee.userId,
        'Avans so‘rovi rad etildi',
        dto.note || 'Avans so‘rovi bo‘yicha rad javobi berildi.',
        { advanceId: id },
      );
      return rejected;
    }

    const approvedAmount = dto.approvedAmount ?? Number(item.requestedAmount);
    if (approvedAmount > Number(item.employee.baseSalary)) {
      throw new BadRequestException(
        'Tasdiqlangan avans bazaviy oylikdan yuqori bo‘lishi mumkin emas',
      );
    }
    const approved = await this.prisma.salaryAdvance.update({
      where: { id },
      data: {
        status: SalaryAdvanceStatus.APPROVED,
        approvedAmount,
        approvedById: actorId,
        approvedAt: new Date(),
        note: dto.note ?? item.note,
      },
    });
    this.notifyEmployee(
      item.employee.userId,
      'Avans tasdiqlandi',
      `${approvedAmount.toLocaleString('ru-RU')} so‘m avans tasdiqlandi.`,
      { advanceId: id },
    );
    return approved;
  }

  async markAdvancePaid(
    id: string,
    hospitalId: string | undefined,
    dto: MarkAdvancePaidDto,
  ) {
    const item = await this.prisma.salaryAdvance.findFirst({
      where: { id, ...(hospitalId && { hospitalId }) },
    });
    if (!item) throw new NotFoundException('Avans topilmadi');
    if (item.status !== SalaryAdvanceStatus.APPROVED) {
      throw new ConflictException(
        'Faqat tasdiqlangan avans to‘landi deb belgilanadi',
      );
    }
    if (dto.paidAmount > Number(item.approvedAmount)) {
      throw new BadRequestException(
        'To‘lov tasdiqlangan avansdan oshmasligi kerak',
      );
    }
    return this.prisma.salaryAdvance.update({
      where: { id },
      data: {
        status: SalaryAdvanceStatus.PAID,
        paidAmount: dto.paidAmount,
        paymentReference: dto.paymentReference.trim(),
        paidAt: new Date(),
      },
    });
  }

  listAdvances(params: {
    hospitalId?: string;
    employeeId?: string;
    month?: number;
    year?: number;
  }) {
    return this.prisma.salaryAdvance.findMany({
      where: {
        ...(params.hospitalId && { hospitalId: params.hospitalId }),
        ...(params.employeeId && { employeeId: params.employeeId }),
        ...(params.month && { month: params.month }),
        ...(params.year && { year: params.year }),
      },
      include: { employee: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Xodim o'z so'rovini ko'rib chiqilguncha bekor qila oladi */
  async cancelMyAdvance(id: string, userId: string) {
    const item = await this.prisma.salaryAdvance.findFirst({
      where: { id, employee: { userId } },
    });
    if (!item) throw new NotFoundException('Avans so‘rovi topilmadi');
    if (item.status !== SalaryAdvanceStatus.REQUESTED) {
      throw new ConflictException(
        'Faqat ko‘rib chiqilmagan so‘rovni bekor qilish mumkin',
      );
    }
    return this.prisma.salaryAdvance.update({
      where: { id },
      data: { status: SalaryAdvanceStatus.CANCELLED },
    });
  }

  async myAdvances(userId: string, month?: number, year?: number) {
    const employee = await this.prisma.employee.findFirst({
      where: { userId },
    });
    if (!employee) throw new NotFoundException('Xodim topilmadi');
    return this.listAdvances({ employeeId: employee.id, month, year });
  }
}
