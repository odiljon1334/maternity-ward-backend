import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clearHospitalBlockCache } from '../common/utils/payment.util';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { getMonthlyExpectedAmount } from '../common/utils/pricing.util';
import {
  addPeriods,
  billingStartPeriods,
  buildCoverage,
  firstBillablePeriod,
  isPeriodCovered,
  isValidPeriod,
  lastNPeriods,
  lastPaidPeriod,
  monthsForType,
  PeriodCoverage,
  periodEnd,
  periodOf,
  periodPaidAmount,
  periodStart,
  periodStatus,
} from './billing.util';

/** Joriy oy (Toshkent vaqti bo'yicha), "YYYY-MM" */
export function currentPeriod(): string {
  return periodOf(new Date());
}

/** Yillik to'lov oldingi 11 oyni ham qoplashi mumkin — so'rov oynasi shuncha kengaytiriladi */
const COVERAGE_LOOKBACK_MONTHS = 11;

export interface HospitalBillingState {
  employeeCount: number;
  expectedMonthly: number;
  /** Oxirgi to'liq to'langan oy (null — hech qachon) */
  lastPaidPeriod: string | null;
  /** Qoplama tugaydigan lahza (lastPaidPeriod oxiri) */
  paidThrough: Date | null;
  /** Oylik to'lov shu oydan boshlanadi (eng eski to'lanmagan oy) */
  nextPeriod: string;
  /** Yillik to'lov shu oydan boshlanadi (12 oyning hech biri qoplanmagan) */
  annualStart: string;
  /** Muddati o'tgan, to'lanmagan oylar (oxirgi 3 oy ichida, sinovdan keyin) */
  overduePeriods: string[];
  /** Qoplangan oylar (joriy oydan −24 … +36) — ustma-ust to'lovni tekshirish uchun */
  coveredPeriods: string[];
}

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Shifoxonalar bo'yicha oy → qoplama xaritasi. Faqat PAID to'lovlar
   * hisobga olinadi (ilgari PENDING/OVERDUE yozuvlar ham "to'langan"
   * summaga qo'shilib ketardi).
   */
  private async loadCoverage(
    hospitalIds: string[],
    fromPeriod: string,
    db: Db = this.prisma,
  ): Promise<Map<string, Map<string, PeriodCoverage>>> {
    const result = new Map<string, Map<string, PeriodCoverage>>();
    if (!hospitalIds.length) return result;
    const since = addPeriods(fromPeriod, -COVERAGE_LOOKBACK_MONTHS);
    const payments = await db.payment.findMany({
      where: {
        hospitalId: { in: hospitalIds },
        status: 'PAID',
        OR: [
          { period: { gte: since } },
          { period: null, paidAt: { gte: periodStart(since) } },
        ],
      },
      select: {
        hospitalId: true,
        period: true,
        months: true,
        amount: true,
        paidAt: true,
        employeeCount: true,
        invoiceId: true,
      },
    });
    const byHospital = new Map<string, typeof payments>();
    for (const p of payments) {
      const list = byHospital.get(p.hospitalId) ?? [];
      list.push(p);
      byHospital.set(p.hospitalId, list);
    }
    for (const id of hospitalIds) {
      result.set(id, buildCoverage(byHospital.get(id) ?? []));
    }
    return result;
  }

  /** Muddati o'tgan ochiq Telegram invoyslarini yopadi (cron) */
  async expireStaleInvoices(now: Date = new Date()): Promise<number> {
    const res = await this.prisma.subscriptionInvoice.updateMany({
      where: { status: 'OPEN', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    return res.count;
  }

  /** Bitta shifoxonaning obuna holati — Telegram bot va avto-blok shu yerdan o'qiydi */
  /**
   * Bitta shifoxonaning obuna holati — Telegram bot, operator va avto-blok
   * shu yerdan o'qiydi. `db` — tranzaksiya ichida (to'lovni yozishda) chaqirish uchun.
   */
  async getBillingState(
    hospitalId: string,
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<HospitalBillingState> {
    const [employeeCount, hospital] = await Promise.all([
      db.employee.count({ where: { hospitalId, firedAt: null } }),
      db.hospital.findUnique({
        where: { id: hospitalId },
        select: { createdAt: true },
      }),
    ]);
    const expectedMonthly = getMonthlyExpectedAmount(employeeCount);
    const current = periodOf(now);
    // Oldindan to'langan kelgusi oylarni ham ko'rish uchun oyna keng olinadi
    const coverage =
      (await this.loadCoverage([hospitalId], addPeriods(current, -24), db)).get(
        hospitalId,
      ) ?? new Map<string, PeriodCoverage>();
    // Xodimsiz (kutilgan summa 0) muassasada har oy "to'langan" hisoblanadi —
    // boshlanish oyi uchun esa faqat haqiqiy to'lovlar qoplama bo'ladi
    const covered = (p: string) => {
      const c = coverage.get(p);
      if (expectedMonthly <= 0)
        return !!c && (c.prepaid || c.settled || c.paidAmount > 0);
      return isPeriodCovered(expectedMonthly, c);
    };
    const last = lastPaidPeriod(coverage, expectedMonthly);
    const firstBillable = hospital?.createdAt
      ? firstBillablePeriod(hospital.createdAt)
      : null;
    const starts = billingStartPeriods(covered, { now, firstBillable });
    const overduePeriods = [-3, -2, -1]
      .map((i) => addPeriods(current, i))
      .filter(
        (p) =>
          (!firstBillable || p >= firstBillable) &&
          periodStatus(p, expectedMonthly, coverage.get(p), now) === 'OVERDUE',
      );
    const coveredPeriods: string[] = [];
    for (let i = -24; i <= 36; i++) {
      const p = addPeriods(current, i);
      if (covered(p)) coveredPeriods.push(p);
    }
    return {
      employeeCount,
      expectedMonthly,
      lastPaidPeriod: last,
      paidThrough: last ? periodEnd(last) : null,
      nextPeriod: starts.monthly,
      annualStart: starts.annual,
      overduePeriods,
      coveredPeriods,
    };
  }

  // ─── Overview — per-hospital payment dashboard ──────────────────────────────
  async getOverview(hospitalIds?: string[]) {
    const period = currentPeriod();

    const hospitals = await this.prisma.hospital.findMany({
      where: {
        isActive: true,
        ...(hospitalIds && { id: { in: hospitalIds } }),
      },
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
            months: true,
            status: true,
            paidAt: true,
            note: true,
            createdAt: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const coverage = await this.loadCoverage(
      hospitals.map((h) => h.id),
      period,
    );

    return hospitals.map((h) => {
      const employeeCount = h._count.employees;
      const expectedAmount = getMonthlyExpectedAmount(employeeCount);
      const cov = coverage.get(h.id)?.get(period);
      const paidAmount = periodPaidAmount(expectedAmount, cov);
      const status = periodStatus(period, expectedAmount, cov);

      return {
        id: h.id,
        name: h.name,
        code: h.code,
        employeeCount,
        expectedAmount,
        paidAmount,
        remainingAmount:
          status === 'PAID' ? 0 : Math.max(0, expectedAmount - paidAmount),
        status,
        prepaid: !!cov?.prepaid,
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

    // Qaysi oy(lar) uchun: berilmasa — bot bilan bir xil qoida (eng eski
    // to'lanmagan oy; yillikda — 12 oyi bo'sh birinchi oy). Ilgari joriy oy
    // olinardi va u allaqachon to'langan bo'lsa pul hech narsani qoplamasdi.
    const state = await this.getBillingState(dto.hospitalId);
    const months = monthsForType(dto.type);
    const period =
      dto.period ?? (months > 1 ? state.annualStart : state.nextPeriod);
    if (!isValidPeriod(period)) {
      throw new BadRequestException(
        "Davr noto'g'ri: YYYY-MM ko'rinishida bo'lishi kerak",
      );
    }

    const payment = await this.prisma.payment.create({
      data: {
        hospitalId: dto.hospitalId,
        payerName: dto.payerName,
        amount: dto.amount,
        type: dto.type,
        period,
        months,
        status: 'PAID',
        // Kutilgan summa to'lov paytidagi xodimlar soni bo'yicha solishtiriladi
        employeeCount: state.employeeCount,
        validUntil: periodEnd(addPeriods(period, months - 1)),
        note: dto.note,
      },
      include: { hospital: { select: { id: true, name: true, code: true } } },
    });
    clearHospitalBlockCache(dto.hospitalId);
    return payment;
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
  async getDebtorsReport(months = 6, allowedHospitalIds?: string[]) {
    const clampedMonths = Math.min(24, Math.max(1, months));
    const periods = lastNPeriods(clampedMonths);

    const hospitals = await this.prisma.hospital.findMany({
      where: {
        isActive: true,
        ...(allowedHospitalIds && { id: { in: allowedHospitalIds } }),
      },
      select: {
        id: true,
        name: true,
        code: true,
        _count: { select: { employees: { where: { firedAt: null } } } },
      },
      orderBy: { name: 'asc' },
    });
    const hospitalIds = hospitals.map((h) => h.id);

    const coverage = await this.loadCoverage(hospitalIds, periods[0]);

    const lastPayments = await this.prisma.payment.groupBy({
      by: ['hospitalId'],
      where: { hospitalId: { in: hospitalIds }, status: 'PAID' },
      _max: { paidAt: true },
    });
    const lastPaidMap = new Map(
      lastPayments.map((r) => [r.hospitalId, r._max.paidAt]),
    );

    const report = hospitals.map((h) => {
      const expectedAmountPerMonth = getMonthlyExpectedAmount(
        h._count.employees,
      );

      const hCoverage = coverage.get(h.id);
      const monthly = periods.map((period) => {
        const cov = hCoverage?.get(period);
        const paidAmount = periodPaidAmount(expectedAmountPerMonth, cov);
        const status = periodStatus(period, expectedAmountPerMonth, cov);
        return {
          period,
          expectedAmount: expectedAmountPerMonth,
          paidAmount,
          remainingAmount:
            status === 'PAID'
              ? 0
              : Math.max(0, expectedAmountPerMonth - paidAmount),
          status,
          prepaid: !!cov?.prepaid,
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
  async getPlatformStats(months = 8, allowedHospitalIds?: string[]) {
    const clampedMonths = Math.min(24, Math.max(2, months));
    const periods = lastNPeriods(clampedMonths);
    const period = currentPeriod();

    // MRR — tan olingan (recognized) daromad: har bir to'lov qoplagan oylarga
    // teng taqsimlanadi. Ilgari yillik to'lov bitta oyga tushib, o'sha oyda
    // MRR 12 barobar oshib, qolgan 11 oyda 0 ko'rinardi (ARR = MRR×12 ham
    // shunga ko'ra noto'g'ri edi). `collected` — shu oyda haqiqatda tushgan pul.
    const scopeHospitals = await this.prisma.hospital.findMany({
      where: allowedHospitalIds
        ? { id: { in: allowedHospitalIds } }
        : undefined,
      select: { id: true },
    });
    const coverage = await this.loadCoverage(
      scopeHospitals.map((h) => h.id),
      periods[0],
    );
    const recognizedByPeriod = new Map<string, number>();
    for (const hMap of coverage.values()) {
      for (const [p, c] of hMap) {
        recognizedByPeriod.set(
          p,
          (recognizedByPeriod.get(p) ?? 0) + c.recognized,
        );
      }
    }
    const collected = await this.prisma.payment.findMany({
      where: {
        status: 'PAID',
        paidAt: { gte: periodStart(periods[0]) },
        ...(allowedHospitalIds && { hospitalId: { in: allowedHospitalIds } }),
      },
      select: { amount: true, paidAt: true },
    });
    const collectedByPeriod = new Map<string, number>();
    for (const c of collected) {
      const p = periodOf(c.paidAt);
      collectedByPeriod.set(
        p,
        (collectedByPeriod.get(p) ?? 0) + Number(c.amount),
      );
    }
    const round = (n: number) => Math.round(n);
    const trend = periods.map((p) => ({
      period: p,
      amount: round(recognizedByPeriod.get(p) ?? 0),
      collected: round(collectedByPeriod.get(p) ?? 0),
    }));

    const mrr = round(recognizedByPeriod.get(period) ?? 0);
    const arr = mrr * 12;

    // To'lov holati taqsimoti (joriy oy) — mavjud getOverview()'ni qayta ishlatamiz.
    const overview = await this.getOverview(allowedHospitalIds);
    const paymentStatusCounts = { PAID: 0, PENDING: 0, OVERDUE: 0 };
    let currentMonthOutstanding = 0;
    for (const h of overview) {
      paymentStatusCounts[h.status]++;
      if (h.status !== 'PAID') currentMonthOutstanding += h.remainingAmount;
    }

    // Faol foydalanuvchilar — oxirgi 7 kun ichida kirganlar
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeUsersCount = await this.prisma.user.count({
      where: {
        lastLoginAt: { gte: sevenDaysAgo },
        ...(allowedHospitalIds && { hospitalId: { in: allowedHospitalIds } }),
      },
    });

    // Rollar taqsimoti
    const roleGroups = await this.prisma.user.groupBy({
      by: ['role'],
      where: allowedHospitalIds
        ? { hospitalId: { in: allowedHospitalIds } }
        : undefined,
      _count: { _all: true },
    });
    const roleDistribution = roleGroups.map((r) => ({
      role: r.role,
      count: r._count._all,
    }));

    // Churn — bloklanmagan lekin FAOLSIZ (isActive:false) YOKI oxirgi 2 oyda
    // hech qanday to'lov qilmagan faol shifoxonalar.
    const allHospitals = await this.prisma.hospital.findMany({
      where: allowedHospitalIds
        ? { id: { in: allowedHospitalIds } }
        : undefined,
      select: { id: true, name: true, code: true, isActive: true },
    });
    const activeIds = allHospitals.filter((h) => h.isActive).map((h) => h.id);
    // "Yaqinda to'lagan" — oxirgi 2 oydan biri to'lov (yoki yillik qoplama) bilan
    // qoplangan. Yillik mijoz endi churn ro'yxatiga tushib qolmaydi.
    const last2Periods = lastNPeriods(2);
    const paidRecentSet = new Set(
      activeIds.filter((id) =>
        last2Periods.some((p) => {
          const c = coverage.get(id)?.get(p);
          return !!c && (c.prepaid || c.paidAmount > 0);
        }),
      ),
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

    const updated = await this.prisma.payment.update({
      where: { id },
      data: {
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
      include: { hospital: { select: { id: true, name: true, code: true } } },
    });
    clearHospitalBlockCache(payment.hospitalId);
    return updated;
  }
}
