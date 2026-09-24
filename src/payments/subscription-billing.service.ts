import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PaymentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getStaffPricing, StaffPricing } from '../common/utils/pricing.util';
import { clearHospitalBlockCache } from '../common/utils/payment.util';
import { PaymentsService } from './payments.service';
import {
  addPeriods,
  comparePeriods,
  coverageLabel,
  monthsForType,
  periodEnd,
} from './billing.util';

/**
 * Telegram Payments orqali obuna to'lovi (FAZA 6 · 2-paket).
 *
 * Oqim:
 *  1. createInvoice — summa va qoplanadigan oylar serverda hisoblanib,
 *     `SubscriptionInvoice` (OPEN, 24 soat) yoziladi. Telegram'ga payload
 *     sifatida faqat `inv:<id>` ketadi.
 *  2. validatePreCheckout — Telegram "to'lashdan oldin" so'raydi: invoys
 *     mavjud, OPEN, muddati o'tmagan, valyuta UZS, summa aynan mos, shu oylar
 *     boshqa to'lov bilan yopilmagan bo'lsagina tasdiqlanadi.
 *  3. recordSuccessfulPayment — idempotent: bir charge id ikki marta kelsa
 *     ikkinchi yozuv yaratilmaydi (UNIQUE + tranzaksiya).
 *
 * ⚠️ Telegram summani valyutaning ENG KICHIK birligida kutadi. UZS uchun
 * `exp = 2` (Telegram currencies.json) — ya'ni 1 so'm = 100 birlik. Ilgari
 * summa so'mda yuborilardi va to'lov 100 barobar arzon chiqardi (yoki
 * minimal summadan past bo'lib rad etilardi).
 */
export const UZS_MINOR_UNITS = 100;
export const INVOICE_TTL_MS = 24 * 60 * 60 * 1000;
const PAYLOAD_PREFIX = 'inv:';

export type InvoiceResult =
  | {
      ok: true;
      invoiceId: string;
      payload: string;
      amountSom: number;
      amountMinor: number;
      months: number;
      startPeriod: string;
      coverage: string;
      employeeCount: number;
      pricing: StaffPricing;
    }
  | { ok: false; reason: 'NEGOTIATED' | 'HOSPITAL_NOT_FOUND' | 'NO_EMPLOYEES' };

export interface PreCheckoutInput {
  payload: string;
  currency: string;
  totalAmount: number;
}

export type PreCheckoutResult = { ok: true } | { ok: false; message: string };

export interface SuccessfulPaymentInput {
  payload: string;
  currency: string;
  totalAmount: number;
  telegramChargeId: string;
  providerChargeId?: string | null;
  chatId: string;
  payerName: string;
}

export type SuccessfulPaymentResult =
  | {
      status: 'RECORDED' | 'DUPLICATE';
      hospitalName: string;
      amountSom: number;
      months: number;
      coverage: string;
      validUntil: Date | null;
      employeeCount: number | null;
    }
  | { status: 'UNKNOWN_INVOICE' };

@Injectable()
export class SubscriptionBillingService {
  private readonly logger = new Logger(SubscriptionBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  /** Obuna holati (bot "Obuna" bo'limi uchun) */
  getState(hospitalId: string, now: Date = new Date()) {
    return this.payments.getBillingState(hospitalId, now);
  }

  async createInvoice(
    hospitalId: string,
    chatId: string,
    type: 'MONTHLY' | 'ANNUAL',
    now: Date = new Date(),
  ): Promise<InvoiceResult> {
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { id: true, isActive: true },
    });
    if (!hospital || !hospital.isActive)
      return { ok: false, reason: 'HOSPITAL_NOT_FOUND' };

    const state = await this.payments.getBillingState(hospitalId, now);
    if (state.employeeCount <= 0) return { ok: false, reason: 'NO_EMPLOYEES' };
    const pricing = getStaffPricing(state.employeeCount);
    if (pricing.negotiated) return { ok: false, reason: 'NEGOTIATED' };

    const months = monthsForType(type);
    const amountSom =
      type === 'MONTHLY' ? pricing.monthlyTotal! : pricing.annualTotal!;
    const startPeriod = state.nextPeriod;

    // Shu chatdagi eski ochiq invoyslar yopiladi — foydalanuvchi eski
    // tugmani bosib, ikki marta to'lab qo'ymasin.
    await this.prisma.subscriptionInvoice.updateMany({
      where: { hospitalId, chatId, status: 'OPEN' },
      data: { status: 'EXPIRED' },
    });

    const invoice = await this.prisma.subscriptionInvoice.create({
      data: {
        hospitalId,
        chatId,
        type: type as PaymentType,
        months,
        startPeriod,
        amount: amountSom,
        currency: 'UZS',
        employeeCount: state.employeeCount,
        expiresAt: new Date(now.getTime() + INVOICE_TTL_MS),
      },
      select: { id: true },
    });

    return {
      ok: true,
      invoiceId: invoice.id,
      payload: `${PAYLOAD_PREFIX}${invoice.id}`,
      amountSom,
      amountMinor: Math.round(amountSom * UZS_MINOR_UNITS),
      months,
      startPeriod,
      coverage: coverageLabel(startPeriod, months),
      employeeCount: state.employeeCount,
      pricing,
    };
  }

  async validatePreCheckout(
    input: PreCheckoutInput,
    now: Date = new Date(),
  ): Promise<PreCheckoutResult> {
    const stale = {
      ok: false as const,
      message:
        "Bu to'lov oynasi eskirgan. Botda «Obuna» bo'limidan to'lovni qaytadan so'rang.",
    };
    if (!input.payload?.startsWith(PAYLOAD_PREFIX)) return stale;

    const invoice = await this.prisma.subscriptionInvoice.findUnique({
      where: { id: input.payload.slice(PAYLOAD_PREFIX.length) },
      include: { hospital: { select: { isActive: true } } },
    });
    if (!invoice || invoice.status !== 'OPEN') return stale;
    if (invoice.expiresAt.getTime() < now.getTime()) return stale;
    if (!invoice.hospital?.isActive) {
      return {
        ok: false,
        message: "Muassasa faol emas. Operator bilan bog'laning.",
      };
    }
    if (input.currency !== invoice.currency) return stale;
    const expectedMinor = Math.round(Number(invoice.amount) * UZS_MINOR_UNITS);
    if (input.totalAmount !== expectedMinor) {
      this.logger.warn(
        `pre_checkout summa mos emas: invoice=${invoice.id} expected=${expectedMinor} got=${input.totalAmount}`,
      );
      return stale;
    }

    // Boshqa to'lov (masalan boshqa direktor yoki operator) shu oylarni allaqachon
    // yopgan bo'lsa — ikkinchi marta pul olinmasin.
    const state = await this.payments.getBillingState(invoice.hospitalId, now);
    if (
      state.lastPaidPeriod &&
      comparePeriods(state.lastPaidPeriod, invoice.startPeriod) >= 0
    ) {
      await this.prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: { status: 'EXPIRED' },
      });
      return {
        ok: false,
        message: `${coverageLabel(invoice.startPeriod, invoice.months)} allaqachon to'langan. Botdan yangilangan hisobni so'rang.`,
      };
    }
    return { ok: true };
  }

  async recordSuccessfulPayment(
    input: SuccessfulPaymentInput,
    now: Date = new Date(),
    retried = false,
  ): Promise<SuccessfulPaymentResult> {
    const amountSom = input.totalAmount / UZS_MINOR_UNITS;

    const existing = await this.prisma.payment.findUnique({
      where: { telegramPaymentId: input.telegramChargeId },
      include: { hospital: { select: { name: true } } },
    });
    if (existing) {
      return {
        status: 'DUPLICATE',
        hospitalName: existing.hospital.name,
        amountSom: Number(existing.amount),
        months: existing.months,
        coverage: existing.period
          ? coverageLabel(existing.period, existing.months)
          : '',
        validUntil: existing.validUntil,
        employeeCount: existing.employeeCount,
      };
    }

    let invoiceId: string | null = null;
    let hospitalId: string;
    let type: PaymentType;
    let months: number;
    let startPeriod: string;
    let employeeCount: number | null;

    if (input.payload?.startsWith(PAYLOAD_PREFIX)) {
      const invoice = await this.prisma.subscriptionInvoice.findUnique({
        where: { id: input.payload.slice(PAYLOAD_PREFIX.length) },
      });
      if (!invoice) {
        this.logger.error(
          `Pul tushdi, lekin invoys topilmadi: payload=${input.payload} charge=${input.telegramChargeId}`,
        );
        return { status: 'UNKNOWN_INVOICE' };
      }
      invoiceId = invoice.id;
      hospitalId = invoice.hospitalId;
      type = invoice.type;
      months = invoice.months;
      startPeriod = invoice.startPeriod;
      employeeCount = invoice.employeeCount;
      const expectedMinor = Math.round(
        Number(invoice.amount) * UZS_MINOR_UNITS,
      );
      if (expectedMinor !== input.totalAmount) {
        this.logger.error(
          `Tushgan summa invoysdan farq qiladi: invoice=${invoice.id} expected=${expectedMinor} got=${input.totalAmount} — yozuv haqiqiy summa bilan saqlanadi`,
        );
      }
    } else {
      // Deploy'dan oldin yuborilgan eski invoys ("MONTHLY:<hospitalId>").
      // Pul baribir tushgan — yo'qotmaslik uchun yoziladi, keyingi to'lanmagan
      // oydan boshlab qoplanadi.
      const [legacyType, legacyHospitalId] = (input.payload ?? '').split(':');
      if (
        !legacyHospitalId ||
        (legacyType !== 'MONTHLY' && legacyType !== 'ANNUAL')
      ) {
        this.logger.error(
          `Noma'lum payload: ${input.payload} charge=${input.telegramChargeId}`,
        );
        return { status: 'UNKNOWN_INVOICE' };
      }
      const hospital = await this.prisma.hospital.findUnique({
        where: { id: legacyHospitalId },
        select: { id: true },
      });
      if (!hospital) return { status: 'UNKNOWN_INVOICE' };
      const state = await this.payments.getBillingState(legacyHospitalId, now);
      hospitalId = legacyHospitalId;
      type = legacyType as PaymentType;
      months = monthsForType(legacyType);
      startPeriod = state.nextPeriod;
      employeeCount = state.employeeCount;
    }

    const validUntil = periodEnd(addPeriods(startPeriod, months - 1));
    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        if (invoiceId) {
          await tx.subscriptionInvoice.update({
            where: { id: invoiceId },
            data: { status: 'PAID', paidAt: now },
          });
        }
        return tx.payment.create({
          data: {
            hospitalId,
            payerName: input.payerName,
            amount: amountSom,
            type,
            months,
            period: startPeriod,
            status: 'PAID',
            paidAt: now,
            employeeCount,
            validUntil,
            telegramPaymentId: input.telegramChargeId,
            providerPaymentId: input.providerChargeId ?? null,
            paidByChatId: input.chatId,
            invoiceId,
            note: invoiceId
              ? "Telegram orqali to'lov"
              : "Telegram orqali to'lov (eski invoys)",
          },
          include: { hospital: { select: { name: true } } },
        });
      });
      clearHospitalBlockCache(hospitalId);
      return {
        status: 'RECORDED',
        hospitalName: payment.hospital.name,
        amountSom,
        months,
        coverage: coverageLabel(startPeriod, months),
        validUntil,
        employeeCount,
      };
    } catch (e) {
      // Bir vaqtda kelgan ikki xabar — ikkinchisi UNIQUE'ga uriladi
      if (
        !retried &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return this.recordSuccessfulPayment(input, now, true);
      }
      throw e;
    }
  }
}
