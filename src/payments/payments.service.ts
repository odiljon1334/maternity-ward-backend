import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';

const PRICE_PER_EMPLOYEE = 20_000;

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getPeriodStatus(
  paidAmount: number,
  expectedAmount: number,
  period: string,
): 'PAID' | 'PENDING' | 'OVERDUE' {
  if (expectedAmount === 0 || paidAmount >= expectedAmount) return 'PAID';

  const [y, m] = period.split('-').map(Number);
  const periodEnd = new Date(y, m, 0, 23, 59, 59); // last day of month

  return new Date() <= periodEnd ? 'PENDING' : 'OVERDUE';
}

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Overview — per-hospital payment dashboard ──────────────────────────────
  async getOverview() {
    const period = currentPeriod();

    const hospitals = await this.prisma.hospital.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        code: true,
        _count: { select: { employees: { where: { firedAt: null } } } },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            payerName: true,
            amount: true,
            type: true,
            period: true,
            paidAt: true,
            note: true,
            createdAt: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const periodTotals = await this.prisma.payment.groupBy({
      by: ['hospitalId'],
      where: { period },
      _sum: { amount: true },
    });
    const totalsMap = new Map(
      periodTotals.map((r) => [r.hospitalId, Number(r._sum.amount ?? 0)]),
    );

    return hospitals.map((h) => {
      const employeeCount = h._count.employees;
      const expectedAmount = employeeCount * PRICE_PER_EMPLOYEE;
      const paidAmount = totalsMap.get(h.id) ?? 0;
      const status = getPeriodStatus(paidAmount, expectedAmount, period);

      return {
        id: h.id,
        name: h.name,
        code: h.code,
        employeeCount,
        expectedAmount,
        paidAmount,
        remainingAmount: Math.max(0, expectedAmount - paidAmount),
        status,
        period,
        recentPayments: h.payments,
      };
    });
  }

  // ─── List payments ───────────────────────────────────────────────────────────
  async findAll(params?: {
    hospitalId?: string;
    period?: string;
    limit?: number;
  }) {
    const where: any = {};
    if (params?.hospitalId) where.hospitalId = params.hospitalId;
    if (params?.period) where.period = params.period;

    return this.prisma.payment.findMany({
      where,
      include: { hospital: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      take: params?.limit || 100,
    });
  }

  // ─── Create payment ──────────────────────────────────────────────────────────
  async create(dto: CreatePaymentDto) {
    const exists = await this.prisma.hospital.findUnique({
      where: { id: dto.hospitalId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Kasalxona topilmadi');

    const period = currentPeriod();

    return this.prisma.payment.create({
      data: {
        hospitalId: dto.hospitalId,
        payerName: dto.payerName,
        amount: dto.amount,
        type: dto.type,
        period,
        note: dto.note,
      },
      include: { hospital: { select: { id: true, name: true, code: true } } },
    });
  }

  // ─── Update payment amount (SUPER_ADMIN only) ────────────────────────────────
  async update(id: string, dto: UpdatePaymentDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException("To'lov topilmadi");

    return this.prisma.payment.update({
      where: { id },
      data: {
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
      include: { hospital: { select: { id: true, name: true, code: true } } },
    });
  }
}
