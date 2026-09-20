import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { getMonthlyExpectedAmount } from '../common/utils/pricing.util';

export function currentPeriod(): string {
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

/** Oxirgi N oy davri ("YYYY-MM"), eskisidan yangisiga qarab tartiblangan — joriy oy ham kiradi. */
function lastNPeriods(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
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
      const expectedAmount = getMonthlyExpectedAmount(employeeCount);
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

  // ─── Ko'p oylik qarzdorlik hisoboti (FAZA 5, 1-bosqich, 2026-09-19) ─────────
  //
  // Soddalashtirilgan yondashuv (Reja.md'da kelishilganidek): har oy uchun
  // "kutilayotgan summa" JORIY xodimlar sonidan hisoblanadi (tarixiy xodimlar
  // sonini oy-oy kuzatish uchun alohida snapshot jadvali kerak bo'lardi —
  // hozircha bu Faza 5'ning qamroviga kirmaydi). Demak agar bir shifoxonada
  // xodimlar soni oxirgi oylarda sezilarli o'zgargan bo'lsa, o'tgan oylar uchun
  // "kutilgan summa" biroz noaniq bo'lishi mumkin — amalda buning ta'siri kam,
  // chunki maqsad aniq buxgalteriya emas, balki "qaysi shifoxona qancha vaqtdan
  // beri to'lamayapti" degan boshqaruv ko'rinishini berish.
  async getDebtorsReport(months = 6) {
    const clampedMonths = Math.min(24, Math.max(1, months));
    const periods = lastNPeriods(clampedMonths);

    const hospitals = await this.prisma.hospital.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        code: true,
        _count: { select: { employees: { where: { firedAt: null } } } },
      },
      orderBy: { name: 'asc' },
    });
    const hospitalIds = hospitals.map((h) => h.id);

    const periodTotals = await this.prisma.payment.groupBy({
      by: ['hospitalId', 'period'],
      where: { hospitalId: { in: hospitalIds }, period: { in: periods } },
      _sum: { amount: true },
    });
    const paidMap = new Map<string, number>();
    for (const row of periodTotals) {
      paidMap.set(
        `${row.hospitalId}|${row.period}`,
        Number(row._sum.amount ?? 0),
      );
    }

    const lastPayments = await this.prisma.payment.groupBy({
      by: ['hospitalId'],
      where: { hospitalId: { in: hospitalIds } },
      _max: { paidAt: true },
    });
    const lastPaidMap = new Map(
      lastPayments.map((r) => [r.hospitalId, r._max.paidAt]),
    );

    const report = hospitals.map((h) => {
      const expectedAmountPerMonth = getMonthlyExpectedAmount(
        h._count.employees,
      );

      const monthly = periods.map((period) => {
        const paidAmount = paidMap.get(`${h.id}|${period}`) ?? 0;
        const status = getPeriodStatus(
          paidAmount,
          expectedAmountPerMonth,
          period,
        );
        return {
          period,
          expectedAmount: expectedAmountPerMonth,
          paidAmount,
          remainingAmount: Math.max(0, expectedAmountPerMonth - paidAmount),
          status,
        };
      });

      // Eng so'nggi oydan orqaga qarab, uzluksiz TO'LANMAGAN (PENDING yoki
      // OVERDUE) oylar soni — joriy oy ham hisobga kiradi (hali muddati
      // o'tmagan bo'lsa ham, "hozircha to'lamagan" degani).
      let consecutiveUnpaidMonths = 0;
      for (let i = monthly.length - 1; i >= 0; i--) {
        if (monthly[i].status !== 'PAID') consecutiveUnpaidMonths++;
        else break;
      }

      // Jami qarz — FAQAT muddati o'tib ketgan (OVERDUE) oylar bo'yicha;
      // joriy PENDING oy hali muddatida bo'lgani uchun "qarz" hisoblanmaydi.
      const totalDebt = monthly
        .filter((m) => m.status === 'OVERDUE')
        .reduce((sum, m) => sum + m.remainingAmount, 0);

      return {
        id: h.id,
        name: h.name,
        code: h.code,
        employeeCount: h._count.employees,
        expectedAmountPerMonth,
        consecutiveUnpaidMonths,
        totalDebt,
        lastPaymentAt: lastPaidMap.get(h.id) ?? null,
        monthly,
      };
    });

    // Eng ko'p qarzdorlar birinchi bo'lib chiqadi.
    return report.sort(
      (a, b) =>
        b.consecutiveUnpaidMonths - a.consecutiveUnpaidMonths ||
        b.totalDebt - a.totalDebt,
    );
  }

  /**
   * Shu oy uchun to'lov eslatmasi yuborilganini belgilaydi (FAZA 5, 2-bosqich)
   * — `CronService.paymentReminderCron()` oyiga bir marta chaqiradi, takroriy
   * spam bo'lmasligi uchun.
   */
  async markPaymentReminderSent(hospitalId: string, period: string) {
    return this.prisma.hospital.update({
      where: { id: hospitalId },
      data: {
        lastPaymentReminderAt: new Date(),
        lastPaymentReminderPeriod: period,
      },
      select: { id: true },
    });
  }

  // ─── MRR/ARR va churn ko'rinishi (FAZA 5, 3-bosqich, 2026-09-19) ────────────
  //
  // Platforma darajasidagi umumiy ko'rsatkichlar — /panel "Umumiy ko'rinish"
  // sahifasi shu metoddan foydalanadi (avval mock-data.ts'da bo'lgan
  // qiymatlarning o'rnini bosadi).
  async getPlatformStats(months = 8) {
    const clampedMonths = Math.min(24, Math.max(2, months));
    const periods = lastNPeriods(clampedMonths);
    const period = currentPeriod();

    // MRR trendi — har bir davr uchun HAQIQIY to'langan jami summa
    // (barcha shifoxonalar bo'yicha, kutilgan emas — bu haqiqiy daromad).
    const periodSums = await this.prisma.payment.groupBy({
      by: ['period'],
      where: { period: { in: periods } },
      _sum: { amount: true },
    });
    const sumsMap = new Map(
      periodSums.map((r) => [r.period, Number(r._sum.amount ?? 0)]),
    );
    const trend = periods.map((p) => ({
      period: p,
      amount: sumsMap.get(p) ?? 0,
    }));

    const mrr = sumsMap.get(period) ?? 0;
    const arr = mrr * 12;

    // To'lov holati taqsimoti (joriy oy) — mavjud getOverview()'ni qayta ishlatamiz.
    const overview = await this.getOverview();
    const paymentStatusCounts = { PAID: 0, PENDING: 0, OVERDUE: 0 };
    let currentMonthOutstanding = 0;
    for (const h of overview) {
      paymentStatusCounts[h.status]++;
      if (h.status !== 'PAID') currentMonthOutstanding += h.remainingAmount;
    }

    // Faol foydalanuvchilar — oxirgi 7 kun ichida kirganlar
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeUsersCount = await this.prisma.user.count({
      where: { lastLoginAt: { gte: sevenDaysAgo } },
    });

    // Rollar taqsimoti
    const roleGroups = await this.prisma.user.groupBy({
      by: ['role'],
      _count: { _all: true },
    });
    const roleDistribution = roleGroups.map((r) => ({
      role: r.role,
      count: r._count._all,
    }));

    // Churn — bloklanmagan lekin FAOLSIZ (isActive:false) YOKI oxirgi 2 oyda
    // hech qanday to'lov qilmagan faol shifoxonalar.
    const allHospitals = await this.prisma.hospital.findMany({
      select: { id: true, name: true, code: true, isActive: true },
    });
    const activeIds = allHospitals.filter((h) => h.isActive).map((h) => h.id);
    const last2Periods = lastNPeriods(2);
    const recentPayments = activeIds.length
      ? await this.prisma.payment.groupBy({
          by: ['hospitalId'],
          where: {
            hospitalId: { in: activeIds },
            period: { in: last2Periods },
          },
          _sum: { amount: true },
        })
      : [];
    const paidRecentSet = new Set(
      recentPayments
        .filter((r) => Number(r._sum.amount ?? 0) > 0)
        .map((r) => r.hospitalId),
    );
    const churn = allHospitals
      .filter(
        (h) =>
          !h.isActive || (activeIds.includes(h.id) && !paidRecentSet.has(h.id)),
      )
      .map((h) => ({
        id: h.id,
        name: h.name,
        code: h.code,
        reason: !h.isActive
          ? ('INACTIVE' as const)
          : ('NO_RECENT_PAYMENT' as const),
      }));

    return {
      period,
      mrr,
      arr,
      trend,
      paymentStatusCounts,
      currentMonthOutstanding,
      activeUsersCount,
      roleDistribution,
      churn,
      churnCount: churn.length,
    };
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
