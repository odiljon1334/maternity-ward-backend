import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SupportBotService } from '../support-bot/support-bot.service';

const SERVICE_KEY = 'face-match';
const HEALTHY = 'HEALTHY';
const ALERTED = 'ALERTED';

type MonitorTransition =
  | { kind: 'outage'; at: Date; failures: number }
  | { kind: 'recovered'; at: Date }
  | null;

@Injectable()
export class FaceMatchMonitorService {
  private readonly logger = new Logger(FaceMatchMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supportBot: SupportBotService,
  ) {}

  /**
   * Kichik interface ortida health probe, ketma-ket xato chegarasi,
   * replica-safe state transition va operator notification yashirilgan.
   */
  async check(): Promise<void> {
    if (process.env.FACE_MATCH_ENABLED === 'false') return;

    const now = new Date();
    const healthy = await this.probeHealth();
    const transition = await this.recordProbe(healthy, now);
    if (!transition) return;

    if (transition.kind === 'outage') {
      const sent = await this.supportBot.notifyOperationalAlert(
        `🔴 StaffPlusPRO texnik ogohlantirish\n\n` +
          `Face Match xizmati ketma-ket ${transition.failures} marta javob bermadi.\n` +
          `Ta'sir: strict rejimda mobil yuz orqali check-in rad etiladi.\n` +
          `Vaqt: ${this.formatTime(transition.at)}`,
      );
      if (!sent) {
        // Telegram vaqtincha ishlamasa keyingi probe yana urinishi uchun claimni
        // faqat aynan shu alertga tegishli bo'lsa qaytaramiz.
        await this.prisma.operationalServiceMonitor.updateMany({
          where: {
            serviceKey: SERVICE_KEY,
            status: ALERTED,
            alertedAt: transition.at,
          },
          data: { status: HEALTHY, alertedAt: null },
        });
      }
      return;
    }

    const sent = await this.supportBot.notifyOperationalAlert(
      `🟢 StaffPlusPRO texnik xabari\n\n` +
        `Face Match xizmati tiklandi va yana check-in so'rovlarini qabul qilmoqda.\n` +
        `Vaqt: ${this.formatTime(transition.at)}`,
    );
    if (!sent) {
      // Tiklanish xabari yetib bormasa ALERTED holatini qaytaramiz. Keyingi
      // healthy probe recovery xabarini qayta yuboradi; muvaffaqiyatli alert
      // hech qachon takrorlanmaydi.
      await this.prisma.operationalServiceMonitor.updateMany({
        where: {
          serviceKey: SERVICE_KEY,
          status: HEALTHY,
          lastSuccessAt: transition.at,
        },
        data: { status: ALERTED },
      });
    }
  }

  private formatTime(value: Date): string {
    return value.toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
  }

  private async probeHealth(): Promise<boolean> {
    const baseUrl =
      process.env.FACE_MATCH_SERVICE_URL || 'http://face-match:8000';
    const configuredTimeout = Number(
      process.env.FACE_MATCH_HEALTH_TIMEOUT_MS ?? 5000,
    );
    const timeout = Number.isFinite(configuredTimeout)
      ? Math.max(1000, configuredTimeout)
      : 5000;

    try {
      const response = await axios.get(`${baseUrl}/health`, { timeout });
      return response.data?.status === 'ready';
    } catch (error) {
      this.logger.warn(
        `Face Match health tekshiruvi ishlamadi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private get failureThreshold(): number {
    const configured = Number(process.env.FACE_MATCH_ALERT_FAILURES ?? 3);
    return Number.isFinite(configured) ? Math.max(2, configured) : 3;
  }

  private async recordProbe(
    healthy: boolean,
    now: Date,
  ): Promise<MonitorTransition> {
    return this.prisma.$transaction(async (tx) => {
      // Transaction-level advisory lock ikki rolling replica bir daqiqada
      // ishlaganda faqat bittasi monitoring holatini o'zgartirishini ta'minlaydi.
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('staffpluspro-face-match-monitor')) AS locked
      `;
      if (!lock?.locked) return null;

      const current = await tx.operationalServiceMonitor.findUnique({
        where: { serviceKey: SERVICE_KEY },
      });

      if (healthy) {
        if (current?.status === ALERTED) {
          await tx.operationalServiceMonitor.update({
            where: { serviceKey: SERVICE_KEY },
            data: {
              status: HEALTHY,
              consecutiveFailures: 0,
              outageStartedAt: null,
              alertedAt: null,
              lastSuccessAt: now,
            },
          });
          return { kind: 'recovered', at: now };
        }

        await tx.operationalServiceMonitor.upsert({
          where: { serviceKey: SERVICE_KEY },
          create: {
            serviceKey: SERVICE_KEY,
            status: HEALTHY,
            consecutiveFailures: 0,
            lastSuccessAt: now,
          },
          update: {
            status: HEALTHY,
            consecutiveFailures: 0,
            outageStartedAt: null,
            lastSuccessAt: now,
          },
        });
        return null;
      }

      if (current?.status === ALERTED) {
        await tx.operationalServiceMonitor.update({
          where: { serviceKey: SERVICE_KEY },
          data: { lastFailureAt: now },
        });
        return null;
      }

      const failures = (current?.consecutiveFailures ?? 0) + 1;
      const outageStartedAt = current?.outageStartedAt ?? now;
      if (current) {
        await tx.operationalServiceMonitor.update({
          where: { serviceKey: SERVICE_KEY },
          data: {
            consecutiveFailures: failures,
            outageStartedAt,
            lastFailureAt: now,
          },
        });
      } else {
        await tx.operationalServiceMonitor.create({
          data: {
            serviceKey: SERVICE_KEY,
            status: HEALTHY,
            consecutiveFailures: failures,
            outageStartedAt,
            lastFailureAt: now,
          },
        });
      }

      if (failures < this.failureThreshold) return null;

      const claimed = await tx.operationalServiceMonitor.updateMany({
        where: { serviceKey: SERVICE_KEY, status: HEALTHY },
        data: { status: ALERTED, alertedAt: now },
      });
      return claimed.count === 1 ? { kind: 'outage', at: now, failures } : null;
    });
  }
}
